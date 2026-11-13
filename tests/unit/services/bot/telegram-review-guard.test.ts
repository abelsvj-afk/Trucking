// Cross-cutting guard test (Telegram review 2026-11-12, mandatory): replay
// the exact owner transcript against real tool types - four waiting
// proposals, bare YES, bare YES, then the numbered answer - and assert
// the outcome the review demands:
//   1. Yes  -> the load's delivery window is updated (executed)
//   2. Yes  -> the load's stops are replaced (executed)
//   3. "It's active not complete" -> the complete-load proposal is
//      dropped for good; the load stays active, never completed
//   4. "Not sure, no" -> the duty proposal is declined and NEVER
//      executes; no duty row is written
// Nothing re-lists after: no proposal remains waiting, and the reply
// never shows a pause glyph, a raw id, or a raw timestamp.
// No model call anywhere on this path (code-only, like the real turns).
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAgentTurn } from "@/services/bot/agent-turn";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import type { BotChatInput } from "@/services/ai/bot-chat";
import type { AiToolTurnResult, AgentCapableProvider } from "@/services/ai/provider";

const COMPANY = "company-1";
const LOAD_ID = "50dde25b-6aed-42e5-b63f-fffa64fd7b56";
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ISO_SHAPE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "is" | "gte" | "lte" | "in" | "ilike"; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    switch (f.op) {
      case "eq":
        return value === f.val;
      case "is":
        return f.val === null ? value === null || value === undefined : value === f.val;
      case "gte":
        return typeof value === "string" && typeof f.val === "string" ? value >= f.val : Number(value) >= Number(f.val);
      case "lte":
        return typeof value === "string" && typeof f.val === "string" ? value <= f.val : value != null && Number(value) <= Number(f.val);
      case "in":
        return Array.isArray(f.val) && f.val.includes(value);
      case "ilike": {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        return typeof value === "string" && value.toLowerCase().includes(needle);
      }
    }
  });
}

class FakeQuery {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private countHead = false;
  private wantCount = false;

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
    private nextStamp: () => string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.countHead = true;
    if (opts?.count) this.wantCount = true;
    return this;
  }
  insert(payload: Row | Row[]) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ op: "eq", col, val });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ op: "is", col, val });
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push({ op: "gte", col, val });
    return this;
  }
  lte(col: string, val: unknown) {
    this.filters.push({ op: "lte", col, val });
    return this;
  }
  in(col: string, val: unknown) {
    this.filters.push({ op: "in", col, val });
    return this;
  }
  like(col: string, val: unknown) {
    this.filters.push({ op: "ilike", col, val });
    return this;
  }
  ilike(col: string, val: unknown) {
    this.filters.push({ op: "ilike", col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private execute(single: boolean, maybe: boolean) {
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert" && Array.isArray(this.payload)) {
      for (const item of this.payload as Row[]) {
        rows.push({ id: `row-${rows.length + 1}-${Math.random().toString(36).slice(2, 8)}`, created_at: this.nextStamp(), ...item });
      }
      return { data: null, error: null, count: null };
    }
    if (this.op === "insert") {
      const row: Row = {
        id: `row-${rows.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
        created_at: this.nextStamp(),
        ...this.payload,
      };
      rows.push(row);
      return { data: single || maybe ? row : null, error: null, count: null };
    }
    if (this.op === "update") {
      for (const row of rows) if (matches(row, this.filters)) Object.assign(row, this.payload);
      return { data: null, error: null, count: null };
    }
    if (this.op === "delete") {
      this.db[this.table] = rows.filter((row) => !matches(row, this.filters));
      return { data: null, error: null, count: null };
    }
    let matched = rows.filter((row) => matches(row, this.filters));
    if (this.countHead) return { data: null, error: null, count: matched.length };
    if (this.orderCol) {
      const col = this.orderCol;
      matched = [...matched].sort((a, b) => {
        const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    if (single) {
      return matched[0]
        ? { data: matched[0], error: null, count: null }
        : { data: null, error: { message: "no rows found" }, count: null };
    }
    if (maybe) return { data: matched[0] ?? null, error: null, count: null };
    return { data: matched, error: null, count: this.wantCount ? matched.length : null };
  }

  single() {
    return Promise.resolve(this.execute(true, false));
  }
  maybeSingle() {
    return Promise.resolve(this.execute(false, true));
  }
  then<TResult1, TResult2>(
    onFulfilled?: ((value: ReturnType<FakeQuery["execute"]>) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute(false, false)).then(onFulfilled, onRejected);
  }
}

function fakeClient(seed: Record<string, Row[]>): { client: SupabaseClient; db: Record<string, Row[]> } {
  const db: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) db[table] = rows.map((r) => ({ ...r }));
  let tick = 0;
  const base = Date.now();
  const nextStamp = () => new Date(base + tick++ * 1000).toISOString();
  const client = {
    from: (table: string) => new FakeQuery(db, table, nextStamp),
  } as unknown as SupabaseClient;
  return { client, db };
}

function baseSeed(): Record<string, Row[]> {
  return {
    companies: [{ id: COMPANY, ai_globally_disabled: false, deleted_at: null }],
    ai_capability_settings: [{ id: "cs-1", company_id: COMPANY, capability: "bot_chat", enabled: true, deleted_at: null }],
    telegram_messages: [],
    bot_memories: [],
    bot_pending_actions: [],
    loads: [],
    load_stops: [],
    duty_logs: [],
    expenses: [],
    fuel_purchases: [],
    trucks: [{ id: "truck-1", company_id: COMPANY, unit_number: "101", deleted_at: null }],
    brokers: [],
    customers: [],
    drivers: [],
    documents: [],
    dispatch_exchanges: [],
  };
}

function neverCalledProvider() {
  const runToolTurn = vi.fn(async (): Promise<AiToolTurnResult> => {
    throw new Error("the model must not be called on this path");
  });
  const provider: AgentCapableProvider = {
    complete: async () => {
      throw new Error("the model must not be called on this path");
    },
    runToolTurn,
  };
  return { provider, runToolTurn };
}

function input(userText: string, history: BotChatInput["history"] = []): BotChatInput {
  return { userText, history, snapshotText: null, instructions: [], memories: [] };
}

function telegramStore(client: SupabaseClient): BotBrainStore {
  return createBotStore(client, COMPANY, "telegram");
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const live = (db: Record<string, Row[]>) => (db.bot_pending_actions ?? []).filter((r) => !r.deleted_at);

const NEW_STOPS = [
  { seq: 1, kind: "pickup", name: "Kontoor Panama City", address: "Panama City, FL", appointment_at: "2026-11-10T14:00:00.000Z", appointment_tz: "America/Chicago" },
  { seq: 2, kind: "delivery", name: "Kontoor Seminole", address: "Seminole, OK", appointment_at: "2026-11-12T17:00:00.000Z", appointment_tz: "America/Chicago" },
  { seq: 3, kind: "other", name: "Drop lot", address: "Seminole, OK" },
];

function fourProposalsSeed(): Record<string, Row[]> {
  const seed = baseSeed();
  seed.loads = [
    {
      id: LOAD_ID, company_id: COMPANY, origin: "Panama City, FL", destination: "Seminole, OK",
      trip_number: "1874", status: "confirmed", pickup_date: "2026-11-10", delivery_date: "2026-11-13", deleted_at: null,
    },
  ];
  const row = (id: string, min: number, tool: string, args: Row, summary: string) => ({
    id, company_id: COMPANY, channel: "telegram", tool_name: tool, arguments: args, summary, created_at: ago(min), deleted_at: null,
  });
  seed.bot_pending_actions = [
    row("w1", 90, "update_load",
      { load_id: LOAD_ID, delivery_window_start: "2026-11-12T13:00:00.000Z", delivery_window_end: "2026-11-12T16:00:00.000Z" },
      "Update the load: delivery window 1:00 PM – 4:00 PM CT"),
    row("w2", 80, "set_load_stops", { load_id: LOAD_ID, stops: NEW_STOPS }, "Set the stops for Trip 1874: Panama City → Seminole, OK"),
    row("w3", 70, "complete_load", { load_id: LOAD_ID, delivery_date: "2026-11-12" }, "Mark the load COMPLETED, delivered 2026-11-12"),
    row("w4", 60, "log_duty_status", { duty_status: "on_duty", location: "Hattiesburg, MS" }, "Duty status: on_duty starting now in Hattiesburg, MS (paper-log helper)"),
  ];
  return seed;
}

describe("Telegram review guard: the exact 2026-11-11 transcript, replayed", () => {
  it("YES, YES, then '1. Yes 2. Yes 3. It's active not complete 4. Not sure, no'", async () => {
    const { client, db } = fakeClient(fourProposalsSeed());
    const store = telegramStore(client);
    const { provider: noModel, runToolTurn } = neverCalledProvider();

    // Turn 1 — bare YES, list never shown: the short list, nothing runs.
    const first = await runAgentTurn(noModel, store, input("YES"));
    expect(first.reply).toContain("4 things are waiting on you");
    expect(first.reply).toContain("Answer by number");
    expect(first.reply).not.toMatch(UUID_SHAPE);
    expect(first.reply).not.toMatch(ISO_SHAPE);
    expect(live(db)).toHaveLength(4);
    expect(db.loads![0]!.status).toBe("confirmed");
    expect(db.load_stops ?? []).toHaveLength(0);

    // Turn 2 — bare YES again, list now shown: still asks which ones, nothing runs.
    const second = await runAgentTurn(noModel, store, input("YES", [{ role: "assistant", text: first.reply }]));
    expect(second.reply).toContain("Which ones?");
    expect(live(db)).toHaveLength(4);
    expect(db.loads![0]!.status).toBe("confirmed");
    expect(db.load_stops ?? []).toHaveLength(0);
    expect(db.duty_logs ?? []).toHaveLength(0);

    // Turn 3 — the numbered answer. Items 1-2 execute; 3 contradicts and
    // is dropped for good; 4 is a no and is declined, never executed.
    const third = await runAgentTurn(
      noModel,
      store,
      input("1. Yes 2. Yes 3. It's active not complete 4. Not sure, no", [{ role: "assistant", text: second.reply }]),
    );
    expect(runToolTurn).not.toHaveBeenCalled();

    // 1: the delivery window landed on the load.
    expect(db.loads![0]).toMatchObject({
      delivery_window_start: "2026-11-12T13:00:00.000Z",
      delivery_window_end: "2026-11-12T16:00:00.000Z",
    });
    // 2: the stops were replaced with the Seminole delivery.
    expect((db.load_stops ?? []).map((s) => [s.seq, s.kind, s.name])).toEqual([
      [1, "pickup", "Kontoor Panama City"],
      [2, "delivery", "Kontoor Seminole"],
      [3, "other", "Drop lot"],
    ]);
    // 3: the load is STILL active - the complete was never recorded.
    expect(db.loads![0]!.status).toBe("confirmed");
    expect(db.loads![0]!.delivery_date).toBe("2026-11-13");
    // 4: no duty row was ever written.
    expect(db.duty_logs ?? []).toHaveLength(0);

    // Nothing remains waiting, so nothing can re-list.
    expect(live(db)).toHaveLength(0);
    expect(third.reply).not.toContain("Still waiting on you");
    expect(third.reply).not.toContain("Which ones?");
    // 3 was dropped as a contradiction, 4 as a no - both named, neither re-listed.
    expect(third.reply).toContain("Dropped");
    expect(third.reply).toContain("It's active not complete");
    // No pause anywhere: the word and the glyph are gone from Abel's vocabulary.
    expect(third.reply).not.toContain("⏸");
    expect(third.reply).not.toMatch(/pause/i);
    // No raw ids or timestamps in what he reads.
    expect(third.reply).not.toMatch(UUID_SHAPE);
    expect(third.reply).not.toMatch(ISO_SHAPE);
  });
});
