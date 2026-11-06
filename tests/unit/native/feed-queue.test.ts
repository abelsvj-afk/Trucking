import { describe, expect, it, vi } from "vitest";

// The Tracker app's queue/sender (native/tracker/www/feed-queue.js) is plain JS with no platform calls so it
// is tested here, where the build sandbox has no Android SDK.
// @ts-expect-error -- plain JS module (native/tracker/www) with no declaration file
const load = async () => (await import("../../../native/tracker/www/feed-queue.js")) as unknown as {
  enqueue: (q: unknown[], f: { at: number }, now: number) => { at: number }[];
  nextBatch: (q: unknown[]) => { batch: unknown[]; count: number };
  backoffMs: (n: number) => number;
  flush: (a: { queue: { at: number }[]; serverUrl: string; key: string; failures: number; fetchFn: (...a: unknown[]) => Promise<{ status: number; ok: boolean }> }) => Promise<{ queue: unknown[]; outcome: string; failures: number }>;
  toFix: (l: unknown) => Record<string, number> | null;
  MAX_BATCH: number;
  MAX_QUEUE: number;
  MAX_AGE_MS: number;
};
const NOW = 1_800_000_000_000;
const fix = (i: number) => ({ lat: 28, lng: -81, at: NOW - 1000 * i });

describe("Tracker feed queue", () => {
  it("caps the queue (oldest dropped) and discards fixes older than 24 h", async () => {
    const q = await load();
    let queue: { at: number }[] = [];
    for (let i = 0; i < q.MAX_QUEUE + 20; i++) queue = q.enqueue(queue, { at: NOW + i }, NOW + i);
    expect(queue).toHaveLength(q.MAX_QUEUE);
    expect(queue[0]!.at).toBe(NOW + 20);
    const aged = q.enqueue([{ at: NOW - q.MAX_AGE_MS - 1 }], { at: NOW }, NOW);
    expect(aged).toEqual([{ at: NOW }]);
  });

  it("sends oldest-first batches of at most 60 and removes exactly what was sent", async () => {
    const q = await load();
    const queue = Array.from({ length: 75 }, (_, i) => ({ lat: 1, lng: 1, at: NOW + i }));
    const fetchFn = vi.fn(async () => ({ status: 200, ok: true }));
    const r = await q.flush({ queue, serverUrl: "https://x.example/", key: "tdv_k", failures: 2, fetchFn });
    expect(r.outcome).toBe("sent");
    expect(r.failures).toBe(0);
    expect(r.queue).toHaveLength(15);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://x.example/api/v1/position/feed");
    expect(init.headers.Authorization).toBe("Bearer tdv_k");
    expect(JSON.parse(init.body).fixes).toHaveLength(60);
    expect(JSON.parse(init.body).fixes[0].at).toBe(NOW);
  });

  it("keeps the queue and counts a failure on network errors and 5xx/429; backs off", async () => {
    const q = await load();
    const queue = [fix(1)];
    const down = await q.flush({ queue, serverUrl: "https://x", key: "k", failures: 0, fetchFn: async () => { throw new Error("offline"); } });
    expect(down).toMatchObject({ outcome: "retry", failures: 1 });
    expect(down.queue).toHaveLength(1);
    const busy = await q.flush({ queue, serverUrl: "https://x", key: "k", failures: 1, fetchFn: async () => ({ status: 429, ok: false }) });
    expect(busy).toMatchObject({ outcome: "retry", failures: 2 });
    expect(q.backoffMs(1)).toBeLessThan(q.backoffMs(4));
    expect(q.backoffMs(99)).toBe(q.backoffMs(5));
  });

  it("a 401 stops with 'unauthorized' and keeps the data; a 400 drops the unacceptable batch instead of wedging", async () => {
    const q = await load();
    const queue = [fix(2), fix(1)];
    const bad = await q.flush({ queue, serverUrl: "https://x", key: "k", failures: 0, fetchFn: async () => ({ status: 401, ok: false }) });
    expect(bad.outcome).toBe("unauthorized");
    expect(bad.queue).toHaveLength(2);
    const rejected = await q.flush({ queue, serverUrl: "https://x", key: "k", failures: 3, fetchFn: async () => ({ status: 400, ok: false }) });
    expect(rejected.queue).toHaveLength(0);
    expect(rejected.failures).toBe(0);
  });

  it("an empty queue does nothing", async () => {
    const q = await load();
    const fetchFn = vi.fn();
    expect((await q.flush({ queue: [], serverUrl: "https://x", key: "k", failures: 0, fetchFn: fetchFn as never })).outcome).toBe("idle");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("converts a plugin location and rejects unusable input", async () => {
    const q = await load();
    expect(q.toFix({ latitude: 28.5, longitude: -81.3, accuracy: 9, bearing: 270, time: NOW })).toEqual({ lat: 28.5, lng: -81.3, at: NOW, accuracy_m: 9, heading_deg: 270 });
    expect(q.toFix({ latitude: 28.5, longitude: -81.3, bearing: -1, time: NOW })).toEqual({ lat: 28.5, lng: -81.3, at: NOW });
    expect(q.toFix(null)).toBeNull();
    expect(q.toFix({ latitude: "x", longitude: 1 })).toBeNull();
  });
});
