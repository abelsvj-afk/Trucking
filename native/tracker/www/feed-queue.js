// The Tracker's queue and sender (docs/design/background-tracking.md, Path 2). Plain ES module with no
// platform calls, so it is unit-tested from the main repo (tests/unit/native/feed-queue.test.ts).
//
// Rules: fixes are queued durably by the caller; a flush sends at most MAX_BATCH oldest-first; success
// removes exactly what was sent; 401 means the key is bad/revoked (stop, tell the driver, keep nothing
// secret in logs); 429/5xx/network errors keep the queue and back off; fixes older than MAX_AGE_MS are
// dropped (the server drops them anyway); the queue is capped so a long dead-zone cannot fill the phone.

export const MAX_BATCH = 60;
export const MAX_QUEUE = 500;
export const MAX_AGE_MS = 24 * 3600 * 1000;
export const FLUSH_EVERY_MS = 30 * 1000;
export const BACKOFF_STEPS_MS = [15000, 30000, 60000, 120000, 300000];

/** Adds a fix, dropping the oldest when over the cap. Pure. */
export function enqueue(queue, fix, nowMs) {
  const fresh = queue.filter((f) => nowMs - f.at <= MAX_AGE_MS);
  fresh.push(fix);
  return fresh.length > MAX_QUEUE ? fresh.slice(fresh.length - MAX_QUEUE) : fresh;
}

/** The next batch (oldest first) and how many were taken. Pure. */
export function nextBatch(queue) {
  const batch = queue.slice(0, MAX_BATCH);
  return { batch, count: batch.length };
}

export function backoffMs(failures) {
  return BACKOFF_STEPS_MS[Math.min(Math.max(failures, 1), BACKOFF_STEPS_MS.length) - 1];
}

/** Removes the device key (and anything shaped like one) from text that may be logged or shown. */
export function scrubKey(text, key) {
  let out = String(text ?? "");
  if (key) out = out.split(key).join("tdv_[hidden]");
  return out.replace(/tdv_[A-Za-z0-9_-]{12,}/g, "tdv_[hidden]");
}

/** The exact words for a request that never got an answer (no connection, wrong address, blocked). */
export function describeNetworkError(err, url) {
  const name = err && err.name ? String(err.name) : "Error";
  const message = err && err.message ? String(err.message) : String(err || "unknown error");
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* show as given */
  }
  return "No answer from " + host + " - " + name + ": " + message + " (the request did not reach the server, or the reply never came back).";
}

/** The exact words the server answered with: HTTP status plus its own error code and message when it sent them. */
export async function describeResponse(res) {
  const status = res && Number.isFinite(res.status) ? res.status : 0;
  let body = "";
  try {
    if (res && typeof res.text === "function") body = await res.text();
  } catch {
    body = "";
  }
  let said = "";
  try {
    const json = JSON.parse(body);
    const e = json && json.error;
    if (e && (e.code || e.message)) said = [e.code, e.message].filter(Boolean).join(": ");
  } catch {
    /* not JSON */
  }
  if (!said && body) said = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return "Server answered HTTP " + status + (said ? " - " + said : " (no message)");
}

/**
 * Sends one batch. Returns { queue, outcome, failures, detail } where outcome is one of
 * "idle" | "sent" | "unauthorized" | "retry", and `detail` is the EXACT reason in words (null when all is well):
 * the server's own HTTP status and error message, or the network error. `fetchFn` is injectable for tests.
 */
export async function flush({ queue, serverUrl, key, failures, fetchFn }) {
  if (queue.length === 0) return { queue, outcome: "idle", failures, detail: null };
  const { batch, count } = nextBatch(queue);
  const url = serverUrl.replace(/\/+$/, "") + "/api/v1/position/feed";
  let res;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ fixes: batch }),
    });
  } catch (err) {
    return { queue, outcome: "retry", failures: failures + 1, detail: describeNetworkError(err, url) };
  }
  if (res.status === 401) return { queue, outcome: "unauthorized", failures, detail: await describeResponse(res) };
  if (res.status === 400) {
    // The server rejected the batch's shape/content: retrying the same bytes forever would wedge the queue.
    return { queue: queue.slice(count), outcome: "sent", failures: 0, detail: (await describeResponse(res)) + " - dropped " + count + " fix(es) it would not accept." };
  }
  if (!res.ok) return { queue, outcome: "retry", failures: failures + 1, detail: await describeResponse(res) };
  const type = res.headers && typeof res.headers.get === "function" ? String(res.headers.get("content-type") || "") : "";
  if (/text\/html/i.test(type)) {
    // A 200 that is a web page (a login redirect, a wrong address) is NOT the position feed answering.
    return { queue, outcome: "retry", failures: failures + 1, detail: "Server answered HTTP " + res.status + " with a web page, not the position feed - check the server URL in Settings." };
  }
  return { queue: queue.slice(count), outcome: "sent", failures: 0, detail: null };
}

/** Converts a plugin location to the feed's fix. Returns null for unusable input. */
export function toFix(location) {
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;
  const fix = { lat: location.latitude, lng: location.longitude, at: Number.isFinite(location.time) ? location.time : Date.now() };
  if (Number.isFinite(location.accuracy)) fix.accuracy_m = Math.max(0, location.accuracy);
  if (Number.isFinite(location.bearing) && location.bearing >= 0 && location.bearing <= 360) fix.heading_deg = location.bearing;
  return fix;
}
