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

/**
 * Sends one batch. Returns { queue, outcome, failures } where outcome is one of
 * "idle" | "sent" | "unauthorized" | "retry". `fetchFn` is injectable for tests.
 */
export async function flush({ queue, serverUrl, key, failures, fetchFn }) {
  if (queue.length === 0) return { queue, outcome: "idle", failures };
  const { batch, count } = nextBatch(queue);
  let res;
  try {
    res = await fetchFn(serverUrl.replace(/\/+$/, "") + "/api/v1/position/feed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ fixes: batch }),
    });
  } catch {
    return { queue, outcome: "retry", failures: failures + 1 };
  }
  if (res.status === 401) return { queue, outcome: "unauthorized", failures };
  if (res.status === 400) {
    // The server rejected the batch's shape/content: retrying the same bytes forever would wedge the queue.
    return { queue: queue.slice(count), outcome: "sent", failures: 0 };
  }
  if (!res.ok) return { queue, outcome: "retry", failures: failures + 1 };
  return { queue: queue.slice(count), outcome: "sent", failures: 0 };
}

/** Converts a plugin location to the feed's fix. Returns null for unusable input. */
export function toFix(location) {
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;
  const fix = { lat: location.latitude, lng: location.longitude, at: Number.isFinite(location.time) ? location.time : Date.now() };
  if (Number.isFinite(location.accuracy)) fix.accuracy_m = Math.max(0, location.accuracy);
  if (Number.isFinite(location.bearing) && location.bearing >= 0 && location.bearing <= 360) fix.heading_deg = location.bearing;
  return fix;
}
