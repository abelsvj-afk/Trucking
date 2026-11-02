// Fix round (pitfall hunt CD-6 + CD-9) - the telegram_processed_updates
// claim lifecycle at store level:
// - claim: first caller wins, a redelivery gets false (23505);
//   before migration 00033 the claim degrades to "proceed" (Lane 1 B-2).
// - release (CD-6): a claim whose turn never completed can be
//   deleted so Telegram's redelivery reprocesses; release errors
//   surface (the caller logs loudly); pre-00033 it is a no-op.
// - prune (CD-9): a successful claim opportunistically deletes
//   claims older than 30 days (processed_at), throttled, and a
//   prune failure never fails the claim.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore } from "@/services/bot/store";

type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

const MISSING_TABLE_ERROR = {
  message: 'relation "telegram_processed_updates" does not exist',
};

class FakeQuery {
  private op: "select" | "insert" | "delete" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
    private flags: { missingTable?: boolean; failLtDelete?: boolean; failDelete?: boolean },
  ) {}

  select() { return this; }
  insert(payload: Row) { this.op = "insert"; this.payload = payload; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ op: "lt", col, val }); return this; }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      const value = row[f.col];
      if (f.op === "eq") return value === f.val;
      if (f.op === "lt") return typeof value === "string" && typeof f.val === "string" ? value < f.val : Number(value) < Number(f.val);
      return true;
    });
  }

  private execute() {
    if (this.flags.missingTable && this.table === "telegram_processed_updates") {
      return { data: null, error: MISSING_TABLE_ERROR, count: null };
    }
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert") {
      if (this.table === "telegram_processed_updates") {
        const dupe = rows.some(
          (r) => r.company_id === this.payload?.company_id && r.update_id === this.payload?.update_id,
        );
        if (dupe) {
          return {
            data: null,
            error: { code: "23505", message: 'duplicate key value violates unique constraint "telegram_processed_updates_pkey"' },
            count: null,
          };
        }
      }
      const row: Row = { processed_at: new Date().toISOString(), ...this.payload };
      rows.push(row);
      return { data: [row], error: null, count: null };
    }
    if (this.op === "delete") {
      if (this.flags.failDelete) return { data: null, error: { message: "connection reset" }, count: null };
      if (this.flags.failLtDelete && this.filters.some((f) => f.op === "lt")) {
        return { data: null, error: { message: "connection reset" }, count: null };
      }
      const kept = rows.filter((r) => !this.matches(r));
      this.db[this.table] = kept;
      return { data: null, error: null, count: rows.length - kept.length };
    }
    return { data: [], error: null, count: 0 };
  }
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: ReturnType<FakeQuery["execute"]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

const COMPANY = "company-1";

function fakeStore(
  db: Record<string, Row[]>,
  flags: { missingTable?: boolean; failLtDelete?: boolean; failDelete?: boolean } = {},
) {
  const client = {
    from: (table: string) => new FakeQuery(db, table, flags),
  } as unknown as SupabaseClient;
  return createBotStore(client, COMPANY, "telegram");
}

describe("telegram update claims (B-2 + CD-6)", () => {
  it("first claim wins; the redelivery is refused", async () => {
    const store = fakeStore({ telegram_processed_updates: [] });
    await expect(store.claimTelegramUpdate(42)).resolves.toBe(true);
    await expect(store.claimTelegramUpdate(42)).resolves.toBe(false);
    await expect(store.claimTelegramUpdate(43)).resolves.toBe(true);
  });

  it("release deletes the claim so the same update can be claimed again", async () => {
    const db: Record<string, Row[]> = { telegram_processed_updates: [] };
    const store = fakeStore(db);
    await expect(store.claimTelegramUpdate(7)).resolves.toBe(true);
    await store.releaseTelegramUpdate(7);
    expect(db.telegram_processed_updates).toHaveLength(0);
    await expect(store.claimTelegramUpdate(7)).resolves.toBe(true);
  });

  it("release surfaces real errors (the caller logs loudly)", async () => {
    const store = fakeStore({ telegram_processed_updates: [] }, { failDelete: true });
    await expect(store.releaseTelegramUpdate(7)).rejects.toThrow("connection reset");
  });

  it("before migration 00033: claim proceeds and release is a silent no-op", async () => {
    const store = fakeStore({ telegram_processed_updates: [] }, { missingTable: true });
    await expect(store.claimTelegramUpdate(9)).resolves.toBe(true);
    await expect(store.releaseTelegramUpdate(9)).resolves.toBeUndefined();
  });
});

describe("CD-9: claims older than 30 days are pruned on claim", () => {
  it("a successful claim deletes stale claims and keeps fresh ones", async () => {
    // Fresh module registry: the prune throttle is per-process
    // module state, and earlier describes already claimed.
    vi.resetModules();
    const { createBotStore: freshCreateBotStore } = await import("@/services/bot/store");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const db: Record<string, Row[]> = {
      telegram_processed_updates: [
        { company_id: COMPANY, update_id: 1, processed_at: old },
        { company_id: COMPANY, update_id: 2, processed_at: fresh },
        { company_id: "other-company", update_id: 3, processed_at: old },
      ],
    };
    const client = {
      from: (table: string) => new FakeQuery(db, table, {}),
    } as unknown as SupabaseClient;
    const store = freshCreateBotStore(client, COMPANY, "telegram");
    await expect(store.claimTelegramUpdate(99)).resolves.toBe(true);
    const remaining = db.telegram_processed_updates!.map((r) => `${r.company_id}:${r.update_id}`);
    expect(remaining).not.toContain(`${COMPANY}:1`); // stale + ours: pruned
    expect(remaining).toContain(`${COMPANY}:2`); // fresh: kept
    expect(remaining).toContain("other-company:3"); // another company's rows are not ours to prune
    expect(remaining).toContain(`${COMPANY}:99`); // the new claim itself
  });

  it("a prune failure never fails the claim", async () => {
    vi.resetModules();
    const { createBotStore: freshCreateBotStore } = await import("@/services/bot/store");
    const db: Record<string, Row[]> = { telegram_processed_updates: [] };
    const client = {
      from: (table: string) => new FakeQuery(db, table, { failLtDelete: true }),
    } as unknown as SupabaseClient;
    const store = freshCreateBotStore(client, COMPANY, "telegram");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(store.claimTelegramUpdate(100)).resolves.toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
