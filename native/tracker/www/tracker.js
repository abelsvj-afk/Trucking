// Trucking OS Tracker: the UI and the platform glue. All queue/sending rules live in feed-queue.js.
// The background-geolocation plugin keeps a foreground service (with a visible notification) alive on
// Android, which is what lets this keep reporting with the screen off and the app closed.

import { enqueue, flush, toFix, backoffMs, FLUSH_EVERY_MS } from "./feed-queue.js";

const Cap = window.Capacitor;
// registerPlugin resolves the native plugin by name; outside the Tracker app (a plain browser) there is no native side.
const BG = Cap && Cap.isNativePlatform && Cap.isNativePlatform() ? Cap.registerPlugin("BackgroundGeolocation") : null;
const Prefs = Cap && Cap.isNativePlatform && Cap.isNativePlatform() ? Cap.registerPlugin("Preferences") : null;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const detailEl = $("detail");
const toggleBtn = $("toggle");

let watcherId = null;
let queue = [];
let failures = 0;
let lastSentAt = null;
let timer = null;
let flushing = false;
let nextTryAt = 0;

async function load(key, fallback = "") {
  try {
    const { value } = await Prefs.get({ key });
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
async function save(key, value) {
  try {
    await Prefs.set({ key, value });
  } catch {
    /* storage failure: tracking still works for this run */
  }
}
async function persistQueue() {
  await save("queue", JSON.stringify(queue));
}

function show(text, detail = "") {
  statusEl.textContent = text;
  detailEl.textContent = detail;
}

async function doFlush() {
  if (flushing || Date.now() < nextTryAt) return;
  flushing = true;
  try {
    const result = await flush({
      queue,
      serverUrl: $("server").value.trim(),
      key: $("key").value.trim(),
      failures,
      fetchFn: (...a) => fetch(...a),
    });
    queue = result.queue;
    failures = result.failures;
    await persistQueue();
    if (result.outcome === "sent") lastSentAt = Date.now();
    if (result.outcome === "unauthorized") {
      await stop("The server refused this key. It may have been revoked - make a new one in Settings.");
      return;
    }
    if (result.outcome === "retry") nextTryAt = Date.now() + backoffMs(failures);
    refresh();
  } finally {
    flushing = false;
  }
}

function refresh() {
  if (watcherId === null) return;
  const sent = lastSentAt ? "Last report sent " + new Date(lastSentAt).toLocaleTimeString() + "." : "Waiting for the first fix...";
  show(failures > 0 ? "Tracking - can't reach the server (will keep trying)." : "Tracking - reporting your position.", sent + " " + queue.length + " waiting to send.");
}

async function start() {
  if (!BG || !Prefs) {
    show("This screen only works inside the Tracker app.");
    return;
  }
  await save("server", $("server").value.trim());
  await save("key", $("key").value.trim());
  if (!$("server").value.trim().startsWith("https://") || !$("key").value.trim().startsWith("tdv_")) {
    show("Enter the https:// server address and the key that starts with tdv_.");
    return;
  }
  watcherId = await BG.addWatcher(
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
          await stop("Location permission is off. Allow location 'all the time' for this app in your phone settings.");
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

toggleBtn.addEventListener("click", () => void (watcherId === null ? start() : stop()));

(async () => {
  if (Prefs) {
    $("server").value = await load("server");
    $("key").value = await load("key");
    try {
      queue = JSON.parse(await load("queue", "[]"));
    } catch {
      queue = [];
    }
    // Resume after the phone or the app restarted mid-shift.
    if ((await load("tracking")) === "1") void start();
  }
})();
