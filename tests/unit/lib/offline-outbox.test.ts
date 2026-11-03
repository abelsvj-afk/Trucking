// GAP-07: the offline outbox — queue on the device, replay on
// signal, never double-book.

import { describe, expect, it } from "vitest";
import { OfflineOutbox, type FetchLike, type KeyValueStorage } from "@/lib/offline-outbox";

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

let counter = 0;
const ids = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

describe("enqueue + flush", () => {
  it("assigns a client id and delivers on flush", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method });
      return { ok: init.method === "POST", status: init.method === "POST" ? 201 : 404 };
    };
    const outbox = new OfflineOutbox({ storage: memoryStorage(), fetchFn, newId: ids });
    const entry = outbox.enqueue("fuel-purchases", { gallons: 100 });
    expect(typeof entry.body.id).toBe("string");
    expect(outbox.count()).toBe(1);

    const result = await outbox.flush();
    expect(result).toEqual({ delivered: 1, remaining: 0 });
    expect(outbox.count()).toBe(0);
    // Existence check first (dedupe), then the create.
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("treats an already-landed row as delivered without re-posting", async () => {
    const methods: string[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      methods.push(init.method);
      return { ok: true, status: 200 };
    };
    const outbox = new OfflineOutbox({ storage: memoryStorage(), fetchFn, newId: ids });
    outbox.enqueue("expenses", { amount_cents: 500 });
    const result = await outbox.flush();
    expect(result.delivered).toBe(1);
    expect(methods).toEqual(["GET"]);
  });

  it("keeps entries queued while the network is down", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("network down");
    };
    const outbox = new OfflineOutbox({ storage: memoryStorage(), fetchFn, newId: ids });
    outbox.enqueue("duty-logs", { duty_status: "driving" });
    const result = await outbox.flush();
    expect(result).toEqual({ delivered: 0, remaining: 1 });
    expect(outbox.list()[0]!.attempts).toBe(1);
  });
});

describe("submitOrQueue", () => {
  it("sends immediately when the network answers ok", async () => {
    const fetchFn: FetchLike = async () => ({ ok: true, status: 201 });
    const outbox = new OfflineOutbox({ storage: memoryStorage(), fetchFn, newId: ids });
    const result = await outbox.submitOrQueue("expenses", { amount_cents: 100 });
    expect(result.status).toBe("sent");
    expect(outbox.count()).toBe(0);
  });

  it("queues on a network failure", async () => {
    const fetchFn: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const outbox = new OfflineOutbox({ storage: memoryStorage(), fetchFn, newId: ids });
    const result = await outbox.submitOrQueue("expenses", { amount_cents: 100 });
    expect(result.status).toBe("queued");
    expect(outbox.count()).toBe(1);
  });

  it("surfaces a server rejection instead of queueing it", async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 422 });
    const outbox = new OfflineOutbox({ storage: memoryStorage(), fetchFn, newId: ids });
    await expect(outbox.submitOrQueue("expenses", { amount_cents: -1 })).rejects.toThrow(
      "server responded 422",
    );
    expect(outbox.count()).toBe(0);
  });
});
