// Trucking OS Tracker: the UI. Since 2026-11-16 the tracking itself is NATIVE (TrackerService.java via the
// "Tracker" plugin): it reads GPS, queues and sends positions with the app closed, keeps its notification up,
// and survives the app being swiped away. Owner report that day: "only tracking when I open it", notification
// gone - the old background-geolocation plugin stopped its service when the app closed and sent nothing
// without this page running. This page only starts/stops it and shows its status and log.
// Settings rules live in settings.js. Two screens: Main (saved address, status, Start/Stop) and Settings.

import { scrubKey } from "./feed-queue.js";
import { validateSettings, isConfigured, describeSaved } from "./settings.js";
import { createOverlay } from "./overlay.js";

const Cap = window.Capacitor;
// registerPlugin comes from Capacitor's JS core (capacitor-core.js, loaded first by index.html) - the native bridge
// alone does not provide it. Outside the Tracker app (a plain browser) there is no native side.
const registerPlugin =
  (Cap && typeof Cap.registerPlugin === "function" && Cap.registerPlugin) ||
  (window.capacitorExports && typeof window.capacitorExports.registerPlugin === "function" && window.capacitorExports.registerPlugin) ||
  null;
const native = Boolean(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const Tracker = native && registerPlugin ? registerPlugin("Tracker") : null;
const Prefs = native && registerPlugin ? registerPlugin("Preferences") : null;
const HosOverlay = native && registerPlugin ? registerPlugin("HosOverlay") : null;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const detailEl = $("detail");
const toggleBtn = $("toggle");

/** The SAVED connection - tracking only ever uses these, never a half-typed field. */
let saved = { server: "", key: "" };
let running = false;
let poll = null;
/** Connection log: kept by the native service (it runs with this page closed); shown here. */
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
function show(text, detail = "") {
  statusEl.textContent = text;
  detailEl.textContent = detail;
}

// ---- connection log -----------------------------------------------------------------------------------

function renderLog() {
  $("log").textContent = logLines.length ? logLines.join("\n") : "No connection events yet.";
}

/** Records an event in the native log (also visible in `adb logcat | grep tracker`). Never contains the key. */
function logEvent(level, message) {
  const clean = scrubKey(message, saved.key);
  (level === "ERROR" ? console.error : console.log)("[tracker] " + clean);
  if (Tracker) {
    void Tracker.appendLog({ level, message: clean }).then(() => refresh()).catch(() => undefined);
  } else {
    logLines.push(new Date().toLocaleString() + "  " + level + "  " + clean);
    renderLog();
  }
}

// ---- floating HOS overlay -----------------------------------------------------------------------------

let overlayOn = false;
const overlay = createOverlay({
  plugin: HosOverlay,
  getSaved: () => saved,
  fetchFn: (...a) => fetch(...a),
  log: (level, message) => logEvent(level, message),
});

function renderOverlay() {
  $("overlay-toggle").textContent = "Floating HOS clocks: " + (overlayOn ? "On" : "Off");
  if (!HosOverlay) $("overlay-status").textContent = "This Tracker build doesn't include the floating clocks yet.";
}

async function toggleOverlay() {
  if (!HosOverlay) {
    $("overlay-status").textContent = "This Tracker build doesn't include the floating clocks yet - it arrives with the next Tracker update.";
    return;
  }
  if (overlayOn) {
    overlayOn = false;
    await save("overlay", "0");
    overlay.stop();
    $("overlay-status").textContent = "Floating clocks off.";
    renderOverlay();
    return;
  }
  if (!isConfigured(saved)) {
    $("overlay-status").textContent = "Save the server URL and your device key above first, then switch this on.";
    return;
  }
  const { granted } = await HosOverlay.canDraw();
  if (!granted) {
    await HosOverlay.requestPermission();
    $("overlay-status").textContent = "Android opened the permission screen - allow \"display over other apps\" for Trucking OS Tracker, then come back and tap this again.";
    return;
  }
  overlayOn = true;
  await save("overlay", "1");
  overlay.start();
  $("overlay-status").textContent = "Floating clocks on - they'll stay on screen over your other apps until you tap the x on the card or switch this off.";
  renderOverlay();
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
  if (changed) {
    // The running service reads its own copy of the connection on every send.
    if (Tracker) await Tracker.configure({ server: saved.server, key: saved.key }).catch(() => undefined);
    logEvent("INFO", "Settings saved - now reporting to " + checked.server + " with the saved key.");
  }
  closeSettings();
  if (running) {
    refresh();
    detailEl.textContent = (changed ? "Saved - the next report uses the new settings. " : "Saved. ") + detailEl.textContent;
  } else {
    show("Saved. Tap Start tracking when you're ready.");
  }
}

// ---- status (read from the native service) ----------------------------------------------------------

async function refresh() {
  if (!Tracker) return;
  let st;
  try {
    st = await Tracker.status();
  } catch {
    return;
  }
  logLines = Array.isArray(st.log) ? st.log : [];
  renderLog();
  running = Boolean(st.running);
  toggleBtn.textContent = running ? "Stop tracking" : "Start tracking";
  if (!running) {
    if (poll) clearInterval(poll);
    poll = null;
    if (st.lastError) show("Not tracking. " + st.lastError);
    return;
  }
  const sent = st.lastSentAt ? "Last report sent " + new Date(st.lastSentAt).toLocaleTimeString() + "." : "Waiting for the first fix...";
  show(
    st.lastError ? "Tracking - the last report failed (will keep trying): " + st.lastError : "Tracking - reporting your position, also with this app closed.",
    sent + " " + st.queued + " waiting to send. The \"Trucking OS Tracker\" notification stays up while it tracks.",
  );
}

function startPolling() {
  if (!poll) poll = setInterval(() => void refresh(), 5000);
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

async function start() {
  if (!Tracker || !Prefs) {
    show(native ? "The tracker's plugin loader is missing (capacitor-core.js) - this build is broken; ask for a new one." : "This screen only works inside the Tracker app.");
    return;
  }
  if (!isConfigured(saved)) {
    openSettings("Save the server URL and your device key first.");
    return;
  }
  show("Starting...", "Android may ask for Location and Notifications - choose Allow for both.");
  toggleBtn.disabled = true;
  try {
    await Tracker.start({ server: saved.server, key: saved.key });
  } catch (err) {
    toggleBtn.disabled = false;
    const why = describeStartError(err);
    logEvent("ERROR", "Could not start: " + why);
    show(why);
    return;
  }
  toggleBtn.disabled = false;
  startPolling();
  await refresh();
}

async function stop() {
  if (Tracker) await Tracker.stop().catch(() => undefined);
  await refresh();
  show("Not tracking.");
}

// ---- wiring -------------------------------------------------------------------------------------------

/** Runs a handler and puts any error on screen - a button can never fail silently. */
const guarded = (fn) => () => {
  fn().catch((err) => {
    toggleBtn.disabled = false;
    show(describeStartError(err));
  });
};

toggleBtn.addEventListener("click", guarded(() => (running ? stop() : start())));
$("open-settings").addEventListener("click", () => openSettings());
$("close-settings").addEventListener("click", () => closeSettings());
$("save-settings").addEventListener("click", guarded(saveSettings));
$("clear-log").addEventListener("click", () => {
  logLines = [];
  renderLog();
  if (Tracker) void Tracker.clearLog().catch(() => undefined);
});
$("overlay-toggle").addEventListener("click", guarded(toggleOverlay));

(async () => {
  saved = { server: await load("server"), key: await load("key") };
  renderLog();
  renderSaved();
  overlayOn = (await load("overlay")) === "1";
  renderOverlay();
  if (overlayOn && isConfigured(saved) && HosOverlay) {
    // Resume the floating clocks too - but only if the permission is still granted.
    HosOverlay.canDraw()
      .then(({ granted }) => {
        if (granted) overlay.start();
        else $("overlay-status").textContent = "Floating clocks are on, but the \"display over other apps\" permission is off - open Settings to fix it.";
      })
      .catch(() => undefined);
  }
  if (!isConfigured(saved)) {
    show("Not set up yet. Open Settings and save the server URL and your device key.");
    return;
  }
  // The native service keeps running with this page closed: opening the app only shows its state.
  await refresh();
  if (running) startPolling();
  else show("Not tracking.");
})();
