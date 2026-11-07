// Trucking OS Tracker: the UI and the platform glue. Queue/sending rules live in feed-queue.js; connection
// settings rules live in settings.js. The background-geolocation plugin keeps a foreground service (with a
// visible notification) alive on Android, which is what lets this keep reporting with the screen off and the
// app closed. Two screens: Main (saved address, status, Start/Stop) and Settings (server URL + device key).

import { enqueue, flush, toFix, backoffMs, scrubKey, FLUSH_EVERY_MS } from "./feed-queue.js";
import { validateSettings, isConfigured, describeSaved } from "./settings.js";

const Cap = window.Capacitor;
// registerPlugin comes from Capacitor's JS core (capacitor-core.js, loaded first by index.html) - the native bridge
// alone does not provide it. Outside the Tracker app (a plain browser) there is no native side.
const registerPlugin =
  (Cap && typeof Cap.registerPlugin === "function" && Cap.registerPlugin) ||
  (window.capacitorExports && typeof window.capacitorExports.registerPlugin === "function" && window.capacitorExports.registerPlugin) ||
  null;
const native = Boolean(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const BG = native && registerPlugin ? registerPlugin("BackgroundGeolocation") : null;
const Prefs = native && registerPlugin ? registerPlugin("Preferences") : null;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const detailEl = $("detail");
const toggleBtn = $("toggle");

/** The SAVED connection - tracking only ever uses these, never a half-typed field. */
let saved = { server: "", key: "" };
let watcherId = null;
let queue = [];
let failures = 0;
let lastSentAt = null;
let timer = null;
let flushing = false;
let nextTryAt = 0;
/** The exact reason for the last failed send (server's own words or the network error); null when fine. */
let lastError = null;
/** Connection log: newest last, capped, kept across restarts, the device key never in it. */
const LOG_MAX = 60;
let logLines = [];

async function load(key, fallback = "") {
  if (!Prefs) return fallback;
  try {
    const { value } = await Prefs.get({ key });
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
async function save(key, value) {
  if (!Prefs) return false;
  try {
    await Prefs.set({ key, value });
    return true;
  } catch {
    return false;
  }
}
async function persistQueue() {
  await save("queue", JSON.stringify(queue));
}

function show(text, detail = "") {
  statusEl.textContent = text;
  detailEl.textContent = detail;
}

// ---- connection log -----------------------------------------------------------------------------------

function renderLog() {
  $("log").textContent = logLines.length ? logLines.join("\n") : "No connection events yet.";
}

/** Records a connection event (also to the phone's console for `adb logcat`). Never contains the key. */
function logEvent(level, message) {
  const line = new Date().toLocaleString() + "  " + level + "  " + scrubKey(message, saved.key);
  logLines.push(line);
  if (logLines.length > LOG_MAX) logLines = logLines.slice(logLines.length - LOG_MAX);
  (level === "ERROR" ? console.error : console.log)("[tracker] " + line);
  renderLog();
  void save("log", JSON.stringify(logLines));
}

// ---- screens ------------------------------------------------------------------------------------------

function renderSaved() {
  const d = describeSaved(saved);
  $("saved-address").textContent = d.address;
  $("saved-key").textContent = d.keyText;
}

function openSettings(message = "") {
  $("server").value = saved.server;
  $("key").value = saved.key;
  $("settings-error").textContent = message;
  $("main-view").hidden = true;
  $("settings-view").hidden = false;
}

function closeSettings() {
  $("settings-view").hidden = true;
  $("main-view").hidden = false;
  renderSaved();
}

async function saveSettings() {
  const checked = validateSettings($("server").value, $("key").value);
  if (!checked.ok) {
    $("settings-error").textContent = checked.error;
    $(checked.field).focus();
    return;
  }
  $("settings-error").textContent = "";
  const ok = (await save("server", checked.server)) && (await save("key", checked.key));
  if (!ok && Prefs) {
    $("settings-error").textContent = "Couldn't save on this phone. Try again.";
    return;
  }
  const changed = checked.server !== saved.server || checked.key !== saved.key;
  saved = { server: checked.server, key: checked.key };
  // A changed connection is a fresh start for the sender's backoff.
  if (changed) {
    failures = 0;
    nextTryAt = 0;
    lastError = null;
    logEvent("INFO", "Settings saved - now reporting to " + checked.server + " with the saved key.");
  }
  closeSettings();
  if (watcherId !== null) {
    refresh();
    detailEl.textContent = (changed ? "Saved - the next report uses the new settings. " : "Saved. ") + detailEl.textContent;
  } else {
    show("Saved. Tap Start tracking when you're ready.");
  }
}

// ---- sending ------------------------------------------------------------------------------------------

async function doFlush() {
  if (flushing || Date.now() < nextTryAt || !isConfigured(saved)) return;
  flushing = true;
  try {
    const result = await flush({
      queue,
      serverUrl: saved.server,
      key: saved.key,
      failures,
      fetchFn: (...a) => fetch(...a),
    });
    queue = result.queue;
    failures = result.failures;
    await persistQueue();
    if (result.outcome === "sent") {
      if (lastError) logEvent("INFO", "Connection restored - reports are being accepted again.");
      lastError = null;
      lastSentAt = Date.now();
      if (result.detail) logEvent("ERROR", result.detail);
    }
    if (result.outcome === "unauthorized") {
      lastError = result.detail;
      logEvent("ERROR", result.detail + " - tracking stopped.");
      await stop("The server refused this key (" + result.detail + "). It may have been revoked - make a new one in Trucking OS, then put it in Settings here.");
      return;
    }
    if (result.outcome === "retry") {
      lastError = result.detail;
      nextTryAt = Date.now() + backoffMs(failures);
      logEvent("ERROR", result.detail + " (attempt " + failures + ", " + queue.length + " waiting, next try in " + Math.round(backoffMs(failures) / 1000) + "s)");
    }
    refresh();
  } finally {
    flushing = false;
  }
}

function refresh() {
  if (watcherId === null) return;
  const sent = lastSentAt ? "Last report sent " + new Date(lastSentAt).toLocaleTimeString() + "." : "Waiting for the first fix...";
  show(
    failures > 0 ? "Tracking - the last report failed (will keep trying): " + (lastError || "unknown error") : "Tracking - reporting your position.",
    sent + " " + queue.length + " waiting to send.",
  );
}

// ---- start / stop -------------------------------------------------------------------------------------

/** What the user should read for an error from the native side - the real reason, never silence. */
function describeStartError(err) {
  const code = err && err.code ? String(err.code) : "";
  const message = err && err.message ? String(err.message) : String(err || "unknown error");
  if (code === "NOT_AUTHORIZED" || /permission/i.test(message)) {
    return "Location permission is off. In phone Settings -> Apps -> Trucking OS Tracker -> Permissions, allow Location (and Notifications), then tap Start again.";
  }
  if (/disabled/i.test(message)) return "Your phone's location is switched off. Turn Location on in the phone's quick settings, then tap Start again.";
  return "Couldn't start tracking: " + message + (code ? " (" + code + ")" : "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** addWatcher, retried while the plugin's native service is still binding ("Service not running."). */
async function addWatcherWhenReady(options, callback) {
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await BG.addWatcher(options, callback);
    } catch (err) {
      lastErr = err;
      if (!(err && /service not running/i.test(String(err.message || "")))) throw err;
      await sleep(700);
    }
  }
  throw lastErr;
}

function startWatcher() {
  return addWatcherWhenReady(
    {
      backgroundTitle: "Trucking OS Tracker",
      backgroundMessage: "Reporting your position so your log can keep up with the truck.",
      requestPermissions: true,
      stale: false,
      distanceFilter: 10,
    },
    async (location, error) => {
      if (error) {
        if (error.code === "NOT_AUTHORIZED") {
          await stop("Location permission is off. In phone Settings -> Apps -> Trucking OS Tracker -> Permissions, allow Location, then tap Start again.");
        }
        return;
      }
      const fix = toFix(location);
      if (!fix) return;
      queue = enqueue(queue, fix, Date.now());
      await persistQueue();
      if (queue.length >= 10) void doFlush();
    },
  );
}

async function start() {
  if (!BG || !Prefs) {
    show(native ? "The tracker's plugin loader is missing (capacitor-core.js) - this build is broken; ask for a new one." : "This screen only works inside the Tracker app.");
    return;
  }
  if (!isConfigured(saved)) {
    openSettings("Save the server URL and your device key first.");
    return;
  }
  show("Starting...", "Android may ask for Location permission - choose Allow.");
  toggleBtn.disabled = true;
  logEvent("INFO", "Starting - reporting to " + saved.server + " with the saved key.");
  try {
    watcherId = await startWatcher();
  } catch (err) {
    watcherId = null;
    toggleBtn.disabled = false;
    toggleBtn.textContent = "Start tracking";
    await save("tracking", "0");
    const why = describeStartError(err);
    logEvent("ERROR", "Could not start: " + why);
    show(why);
    return;
  }
  toggleBtn.disabled = false;
  await save("tracking", "1");
  toggleBtn.textContent = "Stop tracking";
  timer = setInterval(() => void doFlush(), FLUSH_EVERY_MS);
  refresh();
}

async function stop(message = "Not tracking.") {
  if (watcherId !== null && BG) {
    try {
      await BG.removeWatcher({ id: watcherId });
    } catch {
      /* already gone */
    }
  }
  watcherId = null;
  if (timer) clearInterval(timer);
  timer = null;
  await save("tracking", "0");
  toggleBtn.textContent = "Start tracking";
  show(message);
}

// ---- wiring -------------------------------------------------------------------------------------------

/** Runs a handler and puts any error on screen - a button can never fail silently. */
const guarded = (fn) => () => {
  fn().catch((err) => {
    toggleBtn.disabled = false;
    show(describeStartError(err));
  });
};

toggleBtn.addEventListener("click", guarded(() => (watcherId === null ? start() : stop())));
$("open-settings").addEventListener("click", () => openSettings());
$("close-settings").addEventListener("click", () => closeSettings());
$("save-settings").addEventListener("click", guarded(saveSettings));
$("clear-log").addEventListener("click", () => {
  logLines = [];
  renderLog();
  void save("log", "[]");
});

(async () => {
  saved = { server: await load("server"), key: await load("key") };
  try {
    queue = JSON.parse(await load("queue", "[]"));
  } catch {
    queue = [];
  }
  try {
    logLines = JSON.parse(await load("log", "[]"));
  } catch {
    logLines = [];
  }
  renderLog();
  renderSaved();
  if (!isConfigured(saved)) {
    show("Not set up yet. Open Settings and save the server URL and your device key.");
    return;
  }
  // Resume after the phone or the app restarted mid-shift.
  if ((await load("tracking")) === "1") void start();
})();
