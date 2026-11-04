// GAP-07 (Fresh-Eyes Register 2026-11-02) — offline capture.
//
// The dead zones are exactly where the work happens: pumps,
// docks, mountain interstates. A duty change or a fuel stop that
// can't be logged until signal returns is a log that gets
// forgotten. This outbox keeps a create on the device (localStorage)
// and replays it when the network comes back. Creates carry a
// client-generated id (the create schemas accept one), so a replay
// first checks whether the row already landed — a retry can never
// double-book.
//
// Storage and fetch are injectable so the queue logic is unit-
// tested without a browser.

export interface OutboxEntry {
  id: string;
  resource: string;
  body: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number }>;

const STORAGE_KEY = "abel.offlineOutbox.v1";

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export class OfflineOutbox {
  private readonly storage: KeyValueStorage | null;
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    deps: {
      storage?: KeyValueStorage | null;
      fetchFn?: FetchLike;
      now?: () => Date;
      newId?: () => string;
    } = {},
  ) {
    this.storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    this.fetchFn = deps.fetchFn ?? defaultFetch;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  list(): OutboxEntry[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as OutboxEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  count(): number {
    return this.list().length;
  }

  private save(entries: OutboxEntry[]): void {
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(entries));
  }

  enqueue(resource: string, body: Record<string, unknown>): OutboxEntry {
    // Client id: assigned here if the caller didn't, so flush can
    // dedupe against the server copy.
    const withId = typeof body.id === "string" ? body : { ...body, id: this.newId() };
    const entry: OutboxEntry = {
      id: this.newId(),
      resource,
      body: withId,
      queuedAt: this.now().toISOString(),
      attempts: 0,
    };
    this.save([...this.list(), entry]);
    return entry;
  }

  /**
   * Try to deliver every queued entry, oldest first. An entry whose
   * client id already exists server-side counts as delivered (the
   * first attempt landed; only the response was lost). Returns how
   * many were delivered; failures stay queued with attempts bumped.
   */
  async flush(): Promise<{ delivered: number; remaining: number }> {
    let delivered = 0;
    const kept: OutboxEntry[] = [];
    for (const entry of this.list()) {
      const ok = await this.tryDeliver(entry);
      if (ok) delivered += 1;
      else kept.push({ ...entry, attempts: entry.attempts + 1 });
    }
    this.save(kept);
    return { delivered, remaining: kept.length };
  }

  private async tryDeliver(entry: OutboxEntry): Promise<boolean> {
    try {
      const clientId = entry.body.id;
      if (typeof clientId === "string") {
        const existing = await this.fetchFn(`/api/v1/${entry.resource}/${clientId}`, {
          method: "GET",
        });
        if (existing.ok) return true;
      }
      const res = await this.fetchFn(`/api/v1/${entry.resource}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry.body),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * The form path: send now; on a network failure (not a server
   * rejection — a 4xx is a real answer and must surface), queue it
   * on the device instead.
   */
  async submitOrQueue(
    resource: string,
    body: Record<string, unknown>,
  ): Promise<{ status: "sent" } | { status: "queued"; entry: OutboxEntry }> {
    const withId = typeof body.id === "string" ? body : { ...body, id: this.newId() };
    try {
      const res = await this.fetchFn(`/api/v1/${resource}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withId),
      });
      if (res.ok) return { status: "sent" };
      // A server answer (validation, auth) is not an offline case —
      // surface it to the caller as a failure.
      throw new Error(`server responded ${res.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("server responded")) throw err;
      return { status: "queued", entry: this.enqueue(resource, withId) };
    }
  }
}

/** Shared browser instance (components + forms). */
export const offlineOutbox = new OfflineOutbox();
