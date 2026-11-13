// Bot intelligence v2 (docs/design/driver-mvp.md §8). The agent
// turn against an in-memory fake Supabase client - no network:
// - a bot-proposed write is stored as a pending action and inserts
//   NOTHING; the owner's "yes" (resolved in code, no model call)
//   executes it; "no" drops it. No execution without yes, ever.
// - the bot_chat kill switch answers without any model call.
// - THE SAME-BRAIN GUARANTEE: stores built for the telegram and
//   web channels over one client share ONE conversation timeline -
//   turns interleave across channels, and history no longer splits
//   by chat id.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BOT_DISABLED_REPLY, loadBotContext, runAgentTurn } from "@/services/bot/agent-turn";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import type { BotChatInput } from "@/services/ai/bot-chat";
import type {
  AiToolTurnResult,
  AgentCapableProvider,
} from "@/services/ai/provider";

const COMPANY = "company-1";

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
  private op: "select" | "insert" | "update" = "select";
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
    // "news_interest:%" -> starts-with (the fake has no wildcard engine; a prefix is all the bot uses)
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
      for (const row of rows) {
        if (matches(row, this.filters)) Object.assign(row, this.payload);
      }
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
  // Stamps track real now (the pending-action expiry compares against
  // Date.now()) - each insert lands a second after the previous one.
  const base = Date.now();
  const nextStamp = () => new Date(base + tick++ * 1000).toISOString();
  const client = {
    from: (table: string) => new FakeQuery(db, table, nextStamp),
  } as unknown as SupabaseClient;
  return { client, db };
}

function baseSeed(botChatEnabled: boolean): Record<string, Row[]> {
  return {
    companies: [{ id: COMPANY, ai_globally_disabled: false, deleted_at: null }],
    ai_capability_settings: botChatEnabled
      ? [{ id: "cs-1", company_id: COMPANY, capability: "bot_chat", enabled: true, deleted_at: null }]
      : [],
    telegram_messages: [],
    bot_memories: [],
    bot_pending_actions: [],
    loads: [],
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

function scriptedProvider(turns: AiToolTurnResult[]) {
  let index = 0;
  const runToolTurn = vi.fn(async () => {
    const turn = turns[Math.min(index, turns.length - 1)]!;
    index += 1;
    return turn;
  });
  const provider: AgentCapableProvider = {
    complete: async () => {
      throw new Error("complete() is not used by the agent turn");
    },
    runToolTurn,
  };
  return { provider, runToolTurn };
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

function input(userText: string): BotChatInput {
  return { userText, history: [], snapshotText: null, instructions: [], memories: [] };
}

function telegramStore(client: SupabaseClient): BotBrainStore {
  return createBotStore(client, COMPANY, "telegram");
}

describe("runAgentTurn - write approval flow (§8)", () => {
  it("stores a bot-proposed write as pending and inserts nothing until the owner says yes", async () => {
    const { client, db } = fakeClient(baseSeed(true));
    const store = telegramStore(client);
    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          {
            id: "c1",
            name: "create_expense",
            arguments: JSON.stringify({ category: "repairs", amount_dollars: 88, confirmation: "propose" }),
          },
        ],
      },
      { text: "That tire repair sounds like $88.00 - want me to record it?", toolCalls: [] },
    ]);

    const first = await runAgentTurn(provider, store, input("The tire repair cost me 88 bucks"));
    expect(first.reply).toContain("NOT recorded");
    expect(first.reply).toContain("$88.00");
    expect(db.expenses).toHaveLength(0);
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(1);

    // The yes is resolved in code - this provider throws if called.
    const { provider: noModel, runToolTurn } = neverCalledProvider();
    const second = await runAgentTurn(noModel, store, input("yes"));
    expect(runToolTurn).not.toHaveBeenCalled();
    expect(second.reply).toContain("Done");
    expect(second.reply).toContain("$88.00");
    expect(db.expenses).toHaveLength(1);
    expect(db.expenses![0]).toMatchObject({ category: "repairs", amount_cents: 8800, company_id: COMPANY });
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(0);
  });

  it("a write that can NEVER succeed (refused value / missing record) is dropped, not looped - telegram audit P0-2", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [
      {
        id: "p1", company_id: COMPANY, channel: "telegram", tool_name: "create_expense",
        arguments: { category: "repairs", amount_dollars: "not a number" },
        summary: "Expense: broken", created_at: new Date().toISOString(), deleted_at: null,
      },
    ];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, store, input("yes"));
    expect(out.reply).toContain("couldn't be recorded");
    expect(out.reply).toContain("dropped it - nothing was saved");
    expect(db.expenses ?? []).toHaveLength(0);
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(0);
  });

  it("a bare yes targets the proposal just shown, not the oldest one waiting", async () => {
    const seed = baseSeed(true);
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    seed.bot_pending_actions = [
      { id: "old", company_id: COMPANY, channel: "web", tool_name: "create_expense", arguments: { category: "tolls", amount_dollars: 11 }, summary: "Expense: $11.00 (tolls)", created_at: ago(90), deleted_at: null },
      { id: "new", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "repairs", amount_dollars: 88 }, summary: "Expense: $88.00 (repairs)", created_at: ago(1), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(out.reply).toContain("$88.00");
    expect(db.expenses).toHaveLength(1);
    expect(db.expenses![0]).toMatchObject({ category: "repairs" });
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at).map((r) => r.id)).toEqual(["old"]);
  });

  it("with several waiting and none shown recently, a bare yes executes nothing and asks which", async () => {
    const seed = baseSeed(true);
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    seed.bot_pending_actions = [
      { id: "a", company_id: COMPANY, channel: "web", tool_name: "create_expense", arguments: { category: "tolls", amount_dollars: 11 }, summary: "Expense: $11.00 (tolls)", created_at: ago(60), deleted_at: null },
      { id: "b", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "repairs", amount_dollars: 88 }, summary: "Expense: $88.00 (repairs)", created_at: ago(30), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(out.reply).toContain("things are waiting on you");
    expect(out.reply).toContain("$11.00");
    expect(out.reply).toContain("$88.00");
    expect(db.expenses ?? []).toHaveLength(0);
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(2);
  });

  it("'No. Remove that. Add this' cancels the waiting suggestion and can never become a delete of a saved load", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [
      { id: "m", company_id: COMPANY, channel: "telegram", tool_name: "save_memory", arguments: { kind: "fact", content: "old mileage" }, summary: "Remember: old mileage", created_at: new Date(Date.now() - 60_000).toISOString(), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider } = scriptedProvider([
      { text: null, toolCalls: [{ id: "c1", name: "delete_record", arguments: JSON.stringify({ record_type: "load", record_id: "00000000-0000-4000-8000-000000000001", confirmation: "propose" }) }] },
      { text: "Okay, send me the trip details.", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, telegramStore(client), input("No. Remove that. Add this trip: Example Steel Co to Tampa"));
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(0);
    expect(out.reply).not.toMatch(/delete/i);
  });

  it("Trip 1234: one yes saves the load with trip number, reference, exact miles, zones - and its tasks", async () => {
    const seed = baseSeed(true);
    seed.loads = [];
    seed.load_tasks = [];
    seed.load_stops = [];
    seed.bot_pending_actions = [
      {
        id: "t", company_id: COMPANY, channel: "telegram", tool_name: "create_load",
        arguments: {
          origin: "Springfield, MO", destination: "Tampa, FL",
          trip_number: "1234", broker_reference: "REF123456",
          deadhead_miles: 120, loaded_miles: 900.5, miles: 1001,
          pickup_tz: "America/Chicago", delivery_tz: "America/New_York",
          tasks: ["Send trailer and seal photos at each stop", "Send signed BOL to the dispatch group"],
          stops: [
            { seq: 1, kind: "pickup", name: "Example Steel Co", appointment_at: "2026-11-04T06:00:00.000Z", appointment_tz: "America/Chicago" },
            { seq: 2, kind: "delivery", name: "Sample County Recycling", appointment_at: "2026-11-05T05:00:00.000Z", appointment_tz: "America/New_York" },
          ],
        },
        summary: "Load (trip 1234): Springfield, MO → Tampa, FL", created_at: new Date(Date.now() - 60_000).toISOString(), deleted_at: null,
      },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(out.reply).toContain("Done");
    expect(out.reply).toContain("2 trip tasks");
    expect(db.loads).toHaveLength(1);
    expect(db.loads![0]).toMatchObject({ trip_number: "1234", broker_reference: "REF123456", deadhead_miles: 120, loaded_miles: 900.5, pickup_tz: "America/Chicago" });
    expect(db.load_tasks).toHaveLength(2);
    expect(db.load_stops).toHaveLength(2);
    expect(db.load_stops![0]).toMatchObject({ load_id: db.loads![0]!.id, seq: 1, kind: "pickup", appointment_tz: "America/Chicago" });
    expect(db.load_stops!.every((st) => !st.arrived_at && !st.approved_at)).toBe(true);
    expect(db.load_tasks![0]).toMatchObject({ load_id: db.loads![0]!.id });
    expect(db.load_tasks!.every((t) => !t.done_at)).toBe(true);
  });

  it("expired proposals never answer or hijack a new request: they are dropped silently", async () => {
    const seed = baseSeed(true);
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    seed.bot_pending_actions = [
      { id: "s1", company_id: COMPANY, channel: "telegram", tool_name: "save_memory", arguments: { kind: "fact", content: "I drive for ITS" }, summary: "Remember: I drive for ITS", created_at: ago(500), deleted_at: null },
      { id: "s2", company_id: COMPANY, channel: "telegram", tool_name: "save_memory", arguments: { kind: "fact", content: "old" }, summary: "Remember: old", created_at: ago(300), deleted_at: null },
      { id: "live", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "repairs", amount_dollars: 88 }, summary: "Expense: $88.00 (repairs)", created_at: ago(2), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(out.reply).toContain("$88.00");
    expect(out.reply).not.toContain("expired");
    expect(db.expenses).toHaveLength(1);
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(0);
  });

  it("when only an expired proposal is left, a bare yes still gets the honest expiry answer", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [
      { id: "old", company_id: COMPANY, channel: "telegram", tool_name: "save_memory", arguments: { kind: "fact", content: "x" }, summary: "Remember: x", created_at: new Date(Date.now() - 300 * 60_000).toISOString(), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(out.reply).toContain("expired");
    expect(db.bot_memories ?? []).toHaveLength(0);
  });

  it("before migration 00061 is applied the load still saves, trip fields go to notes, and the reply says so", async () => {
    const seed = baseSeed(true);
    seed.loads = [];
    seed.bot_pending_actions = [
      { id: "t", company_id: COMPANY, channel: "telegram", tool_name: "create_load", arguments: { origin: "Springfield, MO", destination: "Tampa, FL", trip_number: "1234", broker_reference: "REF123456" }, summary: "Load (trip 1234)", created_at: new Date(Date.now() - 60_000).toISOString(), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const real = client.from.bind(client);
    const wrapped = {
      ...client,
      from: (table: string) => {
        const q = real(table) as unknown as Record<string, unknown>;
        if (table !== "loads") return q;
        return new Proxy(q, {
          get(target, prop) {
            if (prop === "insert") {
              return (payload: Record<string, unknown>) =>
                "trip_number" in payload
                  ? { select: () => ({ single: async () => ({ data: null, error: { message: 'column "trip_number" of relation "loads" does not exist' } }) }) }
                  : (target.insert as (p: unknown) => unknown)(payload);
            }
            const v = target[prop as string];
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
      },
    } as unknown as SupabaseClient;
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(wrapped), input("yes"));
    expect(out.reply).toContain("Done");
    expect(out.reply).toContain("saved in the notes");
    expect(db.loads).toHaveLength(1);
    expect(String(db.loads![0]!.notes)).toContain("trip number: 1234");
    expect(String(db.loads![0]!.notes)).toContain("broker reference: REF123456");
    expect(db.loads![0]).not.toHaveProperty("trip_number");
  });

  it("set_pay_terms: a yes closes the old terms and starts new dated ones; omitted fields keep their value (unset stays unset)", async () => {
    const seed = baseSeed(true);
    seed.employer_pay_profiles = [
      { id: "p0", company_id: COMPANY, employer_name: "Acme Freight", rate_cents_per_mile: 55, mile_basis: null, worker_type: null, fuel_paid_by: null, effective_from: "2026-10-01", effective_to: null, deleted_at: null },
    ];
    seed.bot_pending_actions = [
      { id: "t", company_id: COMPANY, channel: "telegram", tool_name: "set_pay_terms", arguments: { employer_name: "acme freight", worker_type: "1099" }, summary: "Pay terms for acme freight: 1099 (starts new dated terms)", created_at: new Date(Date.now() - 60_000).toISOString(), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(out.reply).toContain("Done");
    const rows = db.employer_pay_profiles!;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.effective_to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[1]).toMatchObject({ employer_name: "Acme Freight", rate_cents_per_mile: 55, worker_type: "1099", mile_basis: null, fuel_paid_by: null });
    expect(rows[1]!.effective_to ?? null).toBeNull();
  });

  it("'forget this' is a delete PROPOSAL for the memory (D-9): nothing is forgotten until his yes, then it is soft-deleted", async () => {
    const MEM = "77777777-7777-4777-8777-777777777777";
    const seed = baseSeed(true);
    seed.bot_memories = [{ id: MEM, company_id: COMPANY, kind: "fact", content: "My old route was Savannah to Atlanta", source: "telegram", created_at: "2026-10-01T00:00:00Z", deleted_at: null }];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    const { provider } = scriptedProvider([
      { text: null, toolCalls: [{ id: "c1", name: "delete_record", arguments: JSON.stringify({ entity: "memory", record_id: MEM, confirmation: "execute" }) }] },
      { text: "I can forget that - want me to?", toolCalls: [] },
    ]);
    const first = await runAgentTurn(provider, store, input("forget the old route thing"));
    expect(first.reply).toContain("NOT recorded");
    expect(db.bot_memories![0]!.deleted_at).toBeNull(); // always-propose, even when "ordered"
    const { provider: noModel } = neverCalledProvider();
    const second = await runAgentTurn(noModel, store, input("yes"));
    expect(second.reply).toContain("Done");
    expect(db.bot_memories![0]!.deleted_at).toBeTruthy();
  });

  it("create_load carries the trailer; before migration 00066 it still saves with the trailer folded into notes", async () => {
    const TR = "88888888-8888-4888-8888-888888888888";
    const seed = baseSeed(true);
    seed.loads = [];
    seed.bot_pending_actions = [
      { id: "t", company_id: COMPANY, channel: "telegram", tool_name: "create_load", arguments: { origin: "A, MO", destination: "B, FL", trailer_id: TR }, summary: "Load", created_at: new Date(Date.now() - 60_000).toISOString(), deleted_at: null },
    ];
    const ok = fakeClient(seed);
    const out = await runAgentTurn(neverCalledProvider().provider, telegramStore(ok.client), input("yes"));
    expect(out.reply).toContain("Done");
    expect(ok.db.loads![0]).toMatchObject({ trailer_id: TR });
  });

  it("drops the proposal on no - nothing is ever written", async () => {
    const { client, db } = fakeClient(baseSeed(true));
    const store = telegramStore(client);
    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          {
            id: "c1",
            name: "save_memory",
            arguments: JSON.stringify({ kind: "fact", content: "Steven prefers morning pickups", confirmation: "propose" }),
          },
        ],
      },
      { text: "Want me to remember that Steven prefers morning pickups?", toolCalls: [] },
    ]);

    await runAgentTurn(provider, store, input("Steven said he likes morning pickups"));
    expect(db.bot_memories).toHaveLength(0);

    const { provider: noModel } = neverCalledProvider();
    const second = await runAgentTurn(noModel, store, input("no"));
    expect(second.reply).toContain("Cancelled");
    expect(db.bot_memories).toHaveLength(0);
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(0);
  });

  it("executes the owner's own direct order immediately, with no pending proposal", async () => {
    const { client, db } = fakeClient(baseSeed(true));
    const store = telegramStore(client);
    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          {
            id: "c1",
            name: "create_expense",
            arguments: JSON.stringify({ category: "other", amount_dollars: 120, confirmation: "execute" }),
          },
        ],
      },
      { text: "Recorded - $120.00 is in your books.", toolCalls: [] },
    ]);

    const out = await runAgentTurn(provider, store, input("Log $120 for the Pilot stop"));
    expect(out.reply).toBe("Recorded - $120.00 is in your books.");
    expect(db.expenses).toHaveLength(1);
    expect(db.expenses![0]).toMatchObject({ amount_cents: 12000 });
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(0);
  });
});

describe("runAgentTurn - kill switch", () => {
  it("replies that chat is turned off, without any model call, when bot_chat is disabled", async () => {
    const { client } = fakeClient(baseSeed(false));
    const store = telegramStore(client);
    const { provider, runToolTurn } = neverCalledProvider();

    const out = await runAgentTurn(provider, store, input("How much fuel did I buy this week?"));

    expect(runToolTurn).not.toHaveBeenCalled();
    expect(out.reply).toBe(BOT_DISABLED_REPLY);
  });
});

describe("same brain, two windows (§8)", () => {
  it("interleaves telegram and web turns in ONE company timeline", async () => {
    const { client } = fakeClient(baseSeed(true));
    const telegram = createBotStore(client, COMPANY, "telegram");
    const web = createBotStore(client, COMPANY, "web");

    await telegram.saveMessage(4242, "user", "Morning - heading to the truck");
    await web.saveConversationMessage("assistant", "Morning. Your 14-hour window started at 6:00 AM.");
    await telegram.saveMessage(4242, "user", "Got it, rolling now");
    await web.saveConversationMessage("user", "Log that I'm on duty");

    const fromWeb = await web.loadConversationHistory();
    expect(fromWeb.map((t) => t.text)).toEqual([
      "Morning - heading to the truck",
      "Morning. Your 14-hour window started at 6:00 AM.",
      "Got it, rolling now",
      "Log that I'm on duty",
    ]);

    // The telegram surface reads the same timeline - history is not
    // scoped by chat id anymore, so a different chat id changes nothing.
    const fromTelegram = await telegram.loadHistory(999999);
    expect(fromTelegram).toEqual(fromWeb);
  });

  it("shares memories across channels - a web-saved memory loads on the telegram store", async () => {
    const { client } = fakeClient(baseSeed(true));
    const telegram = createBotStore(client, COMPANY, "telegram");
    const web = createBotStore(client, COMPANY, "web");

    await web.saveMemory("fact", "Steven pays every Friday");
    const memories = await telegram.loadMemories();
    expect(memories.map((m) => m.content)).toContain("Steven pays every Friday");
    expect(memories[0]).toMatchObject({ source: "web" });
  });
});

describe("live_location switch (authority-matrix G1)", () => {
  it("is ON with no row (opt-in by sharing), OFF with an explicit off row or the global switch", async () => {
    const none = fakeClient(baseSeed(true));
    expect(await telegramStore(none.client).isLiveLocationEnabled()).toBe(true);

    const offSeed = baseSeed(true);
    offSeed.ai_capability_settings!.push({ id: "cs-2", company_id: COMPANY, capability: "live_location", enabled: false, deleted_at: null });
    expect(await telegramStore(fakeClient(offSeed).client).isLiveLocationEnabled()).toBe(false);

    const globalSeed = baseSeed(true);
    globalSeed.companies = [{ id: COMPANY, ai_globally_disabled: true, deleted_at: null }];
    expect(await telegramStore(fakeClient(globalSeed).client).isLiveLocationEnabled()).toBe(false);
  });
});

// Telegram audit 2026-11-06: the live conversation that went wrong, replayed against the real turn.
describe("transcript regression - telegram audit 2026-11-06", () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const live = (db: Record<string, Row[]>) => db.bot_pending_actions!.filter((r) => !r.deleted_at);

  it("'No that's not it. Delete that' cancels the waiting suggestion AND still hands the rest to the model (P0-1)", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [
      { id: "m", company_id: COMPANY, channel: "telegram", tool_name: "save_memory", arguments: { kind: "fact", content: "that lane is fine" }, summary: "Remember: that lane is fine", created_at: ago(1), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider, runToolTurn } = scriptedProvider([{ text: "Dropped it. Which saved note do you want gone?", toolCalls: [] }]);
    const out = await runAgentTurn(provider, telegramStore(client), input("No that's not it. Delete that"));
    expect(runToolTurn).toHaveBeenCalled();
    expect(live(db)).toHaveLength(0);
    expect(db.bot_memories ?? []).toHaveLength(0);
    expect(out.reply).not.toContain("Done");
  });

  it("an update to a load that does not exist is never proposed (P0-3) - so YES can't loop on it", async () => {
    const { client, db } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          {
            id: "u1",
            name: "update_load",
            arguments: JSON.stringify({ load_id: "deadbeef-0000-4000-8000-000000000000", patch: { delivery_date: "2026-11-06" }, confirmation: "propose" }),
          },
        ],
      },
      { text: "I couldn't find that load in your records.", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, telegramStore(client), input("delivery should say the 6th"));
    expect(live(db)).toHaveLength(0);
    expect(out.reply).not.toContain("NOT recorded");
    const secondCall = JSON.stringify(runToolTurn.mock.calls[1] ?? []);
    expect(secondCall).toContain("NOT PROPOSED");
  });

  it("two proposals in one turn become ONE numbered list one YES answers (P0-4)", async () => {
    const { client, db } = fakeClient(baseSeed(true));
    const store = telegramStore(client);
    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          { id: "a", name: "create_expense", arguments: JSON.stringify({ category: "permits", amount_dollars: 11, confirmation: "propose" }) },
          { id: "b", name: "create_expense", arguments: JSON.stringify({ category: "repairs", amount_dollars: 88, confirmation: "propose" }) },
        ],
      },
      { text: "Two things to record. Please reply YES to confirm.", toolCalls: [] },
    ]);
    const first = await runAgentTurn(provider, store, input("the permit was 11 and the tire was 88"));
    const waiting = live(db);
    expect(waiting).toHaveLength(2);
    expect(new Set(waiting.map((r) => r.batch_id)).size).toBe(1);
    expect(waiting[0]!.batch_id).toBeTruthy();
    // P2-1: only the code's own block asks for the yes.
    expect(first.reply.match(/reply YES/gi) ?? []).toHaveLength(1);

    const { provider: noModel } = neverCalledProvider();
    await runAgentTurn(noModel, store, input("yes"));
    expect(db.expenses).toHaveLength(2);
    expect(live(db)).toHaveLength(0);
  });

  it("after a YES resolves the newest proposal, anything else still waiting is named (P0-5)", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [
      { id: "old", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "tolls", amount_dollars: 11 }, summary: "Expense: $11.00 (tolls)", created_at: ago(40), deleted_at: null },
      { id: "new", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "repairs", amount_dollars: 88 }, summary: "Expense: $88.00 (repairs)", created_at: ago(1), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(db.expenses).toHaveLength(1);
    expect(out.reply).toContain("Still waiting on you");
    expect(out.reply).toContain("$11.00");
  });

  it("'Just completed the load' cannot execute a load decision he never stated (P0-6)", async () => {
    const { client, db } = fakeClient(baseSeed(true));
    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          { id: "d", name: "record_load_decision", arguments: JSON.stringify({ description: "Load to Texas", decision: "taken", confirmation: "execute" }) },
        ],
      },
      { text: "Nice work.", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, telegramStore(client), input("Just completed the load"));
    expect(db.load_decisions ?? []).toHaveLength(0);
    expect(live(db).map((r) => r.tool_name)).toEqual(["record_load_decision"]);
    expect(out.reply).toContain("NOT recorded");
  });

  it("'yes but make it $3,100' is never executed as-is (P1-10)", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [
      { id: "p", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "repairs", amount_dollars: 88 }, summary: "Expense: $88.00 (repairs)", created_at: ago(1), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider, runToolTurn } = scriptedProvider([{ text: "Want it at $3,100 instead?", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("yes but make it $3,100"));
    expect(runToolTurn).toHaveBeenCalled();
    expect(db.expenses ?? []).toHaveLength(0);
  });

  it("a soft 'ok' never approves a delete (P1-10)", async () => {
    const seed = baseSeed(true);
    seed.bot_memories = [{ id: "mem-1", company_id: COMPANY, kind: "fact", content: "x", deleted_at: null }];
    seed.bot_pending_actions = [
      { id: "p", company_id: COMPANY, channel: "telegram", tool_name: "delete_record", arguments: { entity: "memory", record_id: "mem-1" }, summary: "DELETE memory", created_at: ago(1), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("ok"));
    expect(out.reply).toContain("Just to be sure");
    expect(db.bot_memories![0]!.deleted_at).toBeNull();
  });
});

describe("audit follow-up bug fixes", () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const live = (db: Record<string, Row[]>) => db.bot_pending_actions!.filter((r) => !r.deleted_at);

  it("a delete is never merged into the list one YES approves", async () => {
    const seed = baseSeed(true);
    seed.bot_memories = [{ id: "5b1e4c7a-0000-4000-8000-000000000001", company_id: COMPANY, kind: "fact", content: "old", deleted_at: null }];
    const { client, db } = fakeClient(seed);
    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          { id: "a", name: "create_expense", arguments: JSON.stringify({ category: "permits", amount_dollars: 11, confirmation: "propose" }) },
          { id: "b", name: "create_expense", arguments: JSON.stringify({ category: "repairs", amount_dollars: 88, confirmation: "propose" }) },
          { id: "c", name: "delete_record", arguments: JSON.stringify({ entity: "memory", record_id: "5b1e4c7a-0000-4000-8000-000000000001", confirmation: "propose" }) },
        ],
      },
      { text: "Lined up.", toolCalls: [] },
    ]);
    const store = telegramStore(client);
    await runAgentTurn(provider, store, input("record the permit and the tire, and forget the old note"));
    const rows = live(db);
    const del = rows.find((r) => r.tool_name === "delete_record")!;
    expect(del.batch_id ?? null).toBeNull();
    expect(rows.filter((r) => r.batch_id)).toHaveLength(2);

    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, store, input("yes"));
    expect(db.expenses).toHaveLength(2);
    expect(db.bot_memories![0]!.deleted_at).toBeNull();
    expect(out.reply).toContain("Still waiting");
  });

  it("a partial approval does not list the remaining items twice", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [
      { id: "i1", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "permits", amount_dollars: 11 }, summary: "Expense: $11.00 (permits)", batch_id: "b1", item_number: 1, created_at: ago(1), deleted_at: null },
      { id: "i2", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "repairs", amount_dollars: 88 }, summary: "Expense: $88.00 (repairs)", batch_id: "b1", item_number: 2, created_at: ago(1), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("just 1"));
    expect(db.expenses).toHaveLength(1);
    expect(out.reply.match(/Still waiting/g) ?? []).toHaveLength(1);
  });

  it("'reply YES' with nothing staged is stripped - it would answer nothing", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider } = scriptedProvider([{ text: "I couldn't find that load. Reply YES if you want me to create it.", toolCalls: [] }]);
    const out = await runAgentTurn(provider, telegramStore(client), input("update the load"));
    expect(out.reply).not.toMatch(/reply yes/i);
    expect(out.reply).toContain("couldn't find that load");
  });
});

describe("pay terms by percent, and what he will be paid (owner 2026-11-06)", () => {
  const profile = {
    id: "p0", company_id: COMPANY, employer_name: "Acme Freight", rate_cents_per_mile: 0, percent_of_load_bps: 8500,
    mile_basis: null, worker_type: null, fuel_paid_by: null, pay_week_ends_on: 0, payday_weekday: 5,
    effective_from: "2026-01-01", effective_to: null, deleted_at: null,
  };

  it("set_pay_terms with a percent, a pay week end and a payday starts new dated terms that keep everything else", async () => {
    const seed = baseSeed(true);
    seed.employer_pay_profiles = [{ ...profile, percent_of_load_bps: null, rate_cents_per_mile: 55 }];
    seed.bot_pending_actions = [
      { id: "t", company_id: COMPANY, channel: "telegram", tool_name: "set_pay_terms", arguments: { employer_name: "Acme Freight", percent_of_load: 88, pay_week_ends_on: "saturday", payday: "thursday" }, summary: "Pay terms", created_at: new Date(Date.now() - 60_000).toISOString(), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(out.reply).toContain("Done");
    expect(db.employer_pay_profiles![1]).toMatchObject({ rate_cents_per_mile: 55, percent_of_load_bps: 8800, pay_week_ends_on: 6, payday_weekday: 4 });
  });

  it("projected_pay answers from code: this pay week's running total, last week's, and the payday", async () => {
    const seed = baseSeed(true);
    seed.employer_pay_profiles = [profile];
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    seed.loads = [
      { id: "L1", company_id: COMPANY, origin: "Macon, GA", destination: "Tampa, FL", status: "confirmed", rate_cents: 200000, miles: 500, delivery_date: today, pickup_date: today, deleted_at: null },
      { id: "L2", company_id: COMPANY, origin: "Tampa, FL", destination: "Miami, FL", status: "confirmed", rate_cents: 100000, pay_override_cents: 70000, miles: 300, delivery_date: today, pickup_date: today, deleted_at: null },
    ];
    const { client } = fakeClient(seed);
    const { provider, runToolTurn } = scriptedProvider([
      { text: null, toolCalls: [{ id: "p", name: "projected_pay", arguments: "{}" }] },
      { text: "That comes to $2,400.00 so far.", toolCalls: [] },
    ]);
    await runAgentTurn(provider, telegramStore(client), input("how much will I get paid this week?"));
    const toolResult = JSON.stringify(runToolTurn.mock.calls[1] ?? []);
    expect(toolResult).toContain("$2,400.00"); // 85% of $2,000 + his own $700 figure
    expect(toolResult).toContain("[his own figure]");
    expect(toolResult).toContain("paid ");
  });

  it("update_load can carry his own figure for what a load pays him", async () => {
    const LOAD = "9c1e4c7a-0000-4000-8000-0000000000aa";
    const seed = baseSeed(true);
    seed.loads = [{ id: LOAD, company_id: COMPANY, origin: "A", destination: "B", status: "confirmed", rate_cents: 200000, pickup_date: "2026-11-04", delivery_date: "2026-11-05", deleted_at: null }];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    const { provider } = scriptedProvider([
      { text: null, toolCalls: [{ id: "u", name: "update_load", arguments: JSON.stringify({ load_id: LOAD, pay_dollars: 1250, confirmation: "propose" }) }] },
      { text: "Lined up.", toolCalls: [] },
    ]);
    await runAgentTurn(provider, store, input("this one pays me 1,250 flat"));
    const { provider: noModel } = neverCalledProvider();
    await runAgentTurn(noModel, store, input("yes"));
    expect(db.loads![0]).toMatchObject({ pay_override_cents: 125000 });
  });
});

describe("the Yes key (a plain 'Yes' message) approves the waiting proposal", () => {
  it("'Yes' with a capital letter, as the reply keyboard sends it, executes the proposal in code", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [
      { id: "p", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "repairs", amount_dollars: 88 }, summary: "Expense: $88.00 (repairs)", created_at: new Date(Date.now() - 30_000).toISOString(), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider: noModel, runToolTurn } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("Yes"));
    expect(runToolTurn).not.toHaveBeenCalled();
    expect(out.reply).toContain("Done");
    expect(db.expenses).toHaveLength(1);
  });
});

describe("owner 2026-11-07: pay safety, no redundant approvals, saved-where, readable proposals", () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const live = (db: Record<string, Row[]>) => db.bot_pending_actions!.filter((r) => !r.deleted_at);
  const L1 = "9c1e4c7a-0000-4000-8000-0000000000aa";
  const withTerms = () => {
    const seed = baseSeed(true);
    seed.employer_pay_profiles = [
      { id: "p0", company_id: COMPANY, employer_name: "Acme Freight", rate_cents_per_mile: 55, percent_of_load_bps: null, mile_basis: "all", worker_type: null, fuel_paid_by: null, effective_from: "2026-01-01", effective_to: null, deleted_at: null },
    ];
    return seed;
  };
  const proposeTurn = async (client: SupabaseClient, store: BotBrainStore, tool: string, args: Record<string, unknown>) => {
    const { provider, runToolTurn } = scriptedProvider([
      { text: null, toolCalls: [{ id: "c", name: tool, arguments: JSON.stringify({ ...args, confirmation: "propose" }) }] },
      { text: "Lined up.", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, store, input("i dont pay for fuel"));
    return { out, runToolTurn, client };
  };

  it("THE REPORTED BUG: 'I don't pay for fuel' as a pay-pin change keeps his rate (it used to wipe it to zero)", async () => {
    const { client, db } = fakeClient(withTerms());
    const store = telegramStore(client);
    const { out } = await proposeTurn(client, store, "set_pay_pin", { fuel_paid_by: "owner", source: "he said the carrier pays fuel" });
    expect(out.reply).toContain("fuel paid by: not set → owner");
    expect(out.reply).not.toMatch(/CLEARS his rate/);
    const { provider: noModel } = neverCalledProvider();
    const done = await runAgentTurn(noModel, store, input("yes"));
    expect(done.reply).toContain("Done");
    const saved = db.bot_memories!.map((m) => String(m.content)).join("\n");
    expect(saved).toMatch(/0\.55/); // the rate is still there
    expect(saved).toMatch(/cpm_all_miles/);
  });

  it("a pay-pin call that names the same model but no rate keeps the rate too", async () => {
    const { client, db } = fakeClient(withTerms());
    const store = telegramStore(client);
    await proposeTurn(client, store, "set_pay_pin", { model: "cpm_all_miles", fuel_paid_by: "owner", source: "x" });
    const { provider: noModel } = neverCalledProvider();
    await runAgentTurn(noModel, store, input("yes"));
    expect(db.bot_memories!.map((m) => String(m.content)).join("\n")).toMatch(/0\.55/);
  });

  it("switching to a different rate-based model without a rate is refused, never stored as 'no rate'", async () => {
    const { client, db } = fakeClient(withTerms());
    const { out, runToolTurn } = await proposeTurn(client, telegramStore(client), "set_pay_pin", { model: "flat_per_load", source: "x" });
    expect(live(db)).toHaveLength(0);
    expect(JSON.stringify(runToolTurn.mock.calls[1] ?? [])).toMatch(/NOT PROPOSED.*needs its rate/);
    expect(out.reply).not.toContain("⏳");
  });

  it("set_pay_terms: changing only who pays fuel says his rate stays; a zero rate with no percent is refused", async () => {
    const { client, db } = fakeClient(withTerms());
    const store = telegramStore(client);
    const fuel = await proposeTurn(client, store, "set_pay_terms", { employer_name: "Acme Freight", fuel_paid_by: "employer" });
    expect(fuel.out.reply).toContain("fuel paid by employer");
    expect(fuel.out.reply).toContain("his rate stays as it is");
    const zero = await proposeTurn(client, store, "set_pay_terms", { employer_name: "Acme Freight", rate_dollars_per_mile: 0 });
    expect(JSON.stringify(zero.runToolTurn.mock.calls[1] ?? [])).toMatch(/NOT PROPOSED.*no per-mile rate and no percent/);
    expect(live(db).filter((r) => r.tool_name === "set_pay_terms")).toHaveLength(1);
  });

  it("set_pay_terms shows before → after and warns when pay would drop", async () => {
    const { client } = fakeClient(withTerms());
    const r = await proposeTurn(client, telegramStore(client), "set_pay_terms", { employer_name: "Acme Freight", rate_dollars_per_mile: 0.4 });
    expect(r.out.reply).toContain("per mile: $0.55 → $0.40 ⚠ lower pay");
  });

  it("an update that would zero a money field says so before he approves", async () => {
    const seed = baseSeed(true);
    seed.loads = [{ id: L1, company_id: COMPANY, origin: "A", destination: "B", status: "confirmed", rate_cents: 200000, pickup_date: "2026-11-04", delivery_date: "2026-11-05", deleted_at: null }];
    const { client } = fakeClient(seed);
    const r = await proposeTurn(client, telegramStore(client), "update_load", { load_id: L1, rate_dollars: 0 });
    expect(r.out.reply).toMatch(/⚠ this ZEROES rate \(was \$2,000\.00\)/);
  });

  it("an identical proposal already waiting is not asked for again - he is told it is waiting", async () => {
    const seed = baseSeed(true);
    seed.loads = [{ id: L1, company_id: COMPANY, origin: "A", destination: "B", status: "confirmed", rate_cents: 200000, pickup_date: "2026-11-04", delivery_date: "2026-11-05", deleted_at: null }];
    seed.bot_pending_actions = [
      { id: "w", company_id: COMPANY, channel: "telegram", tool_name: "update_load", arguments: { load_id: L1, delivery_date: "2026-11-06" }, summary: "Update load A → B: delivery date → 2026-11-06", created_at: ago(2), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { out } = await proposeTurn(client, telegramStore(client), "update_load", { load_id: L1, delivery_date: "2026-11-06" });
    expect(live(db)).toHaveLength(1);
    expect(out.reply).toContain("already waiting for your yes");
    expect(out.reply.match(/Reply YES/g) ?? []).toHaveLength(1);
    expect(out.reply).toContain("delivery date → Fri Nov 6");
  });

  it("a newer change to the same load replaces the older waiting one", async () => {
    const seed = baseSeed(true);
    seed.loads = [{ id: L1, company_id: COMPANY, origin: "A", destination: "B", status: "confirmed", rate_cents: 200000, pickup_date: "2026-11-04", delivery_date: "2026-11-05", deleted_at: null }];
    seed.bot_pending_actions = [
      { id: "w", company_id: COMPANY, channel: "telegram", tool_name: "update_load", arguments: { load_id: L1, delivery_date: "2026-11-06" }, summary: "old: delivery 6th", created_at: ago(2), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { out } = await proposeTurn(client, telegramStore(client), "update_load", { load_id: L1, delivery_date: "2026-11-07" });
    const waiting = live(db);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.arguments).toMatchObject({ delivery_date: "2026-11-07" });
    expect(out.reply).toContain("replaces the earlier request still waiting: old: delivery 6th");
  });

  it("two changes to the same load in one turn become ONE proposal describing the merged change", async () => {
    const seed = baseSeed(true);
    seed.loads = [{ id: L1, company_id: COMPANY, origin: "A", destination: "B", status: "confirmed", rate_cents: 200000, pickup_date: "2026-11-04", delivery_date: "2026-11-05", deleted_at: null }];
    const { client, db } = fakeClient(seed);
    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          { id: "a", name: "update_load", arguments: JSON.stringify({ load_id: L1, delivery_date: "2026-11-06", confirmation: "propose" }) },
          { id: "b", name: "update_load", arguments: JSON.stringify({ load_id: L1, rate_dollars: 2100, confirmation: "propose" }) },
        ],
      },
      { text: "Lined up.", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, telegramStore(client), input("delivery is the 6th and it pays 2100"));
    const waiting = live(db);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.arguments).toMatchObject({ delivery_date: "2026-11-06", rate_dollars: 2100 });
    expect(out.reply).toContain("combined two changes");
    expect(out.reply).toMatch(/delivery date → Fri Nov 6/);
    expect(out.reply).toMatch(/rate → \$2,100\.00/);
  });

  it("confirmations say WHERE it was kept: 💾 an app record with its page, or 🧠 Abel's own note", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [
      { id: "e", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "repairs", amount_dollars: 88 }, summary: "Expense: $88.00 (repairs)", created_at: ago(1), deleted_at: null },
    ];
    const { client } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const rec = await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(rec.reply).toContain("✅ Done");
    expect(rec.reply).toContain("💾 Saved to your app → Money → Expenses.");

    const seed2 = baseSeed(true);
    seed2.bot_pending_actions = [
      { id: "m", company_id: COMPANY, channel: "telegram", tool_name: "save_memory", arguments: { kind: "fact", content: "Dispatch texts after 8" }, summary: "Remember: Dispatch texts after 8", created_at: ago(1), deleted_at: null },
    ];
    const mem = await runAgentTurn(neverCalledProvider().provider, telegramStore(fakeClient(seed2).client), input("yes"));
    expect(mem.reply).toContain("🧠 Remembered - this is my own note, not an app record");
  });

  it("proposals are laid out with emoji markers, not a bare 'I have NOT recorded' block", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { out } = await proposeTurn(client, telegramStore(client), "create_expense", { category: "repairs", amount_dollars: 88 });
    expect(out.reply).toContain("⏳ I have NOT recorded this yet:");
    expect(out.reply).toContain("👉 Reply YES to confirm, or NO to drop it.");
  });
});

describe("temporal reasoning: Abel's time tools and rules (owner 2026-11-07)", () => {
  it("when_is and time_between are computed in code on his clock and handed back to the model", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          { id: "a", name: "when_is", arguments: JSON.stringify({ phrase: "next friday" }) },
          { id: "b", name: "time_between", arguments: JSON.stringify({ from: "2026-11-06", to: "2026-11-23" }) },
          { id: "c", name: "when_is", arguments: JSON.stringify({ phrase: "sometime soon" }) },
        ],
      },
      { text: "Done.", toolCalls: [] },
    ]);
    await runAgentTurn(provider, telegramStore(client), input("when is next friday and how long until the 23rd"));
    const seen = JSON.stringify(runToolTurn.mock.calls[1] ?? []);
    expect(seen).toMatch(/\\"next friday\\" = \w+, \w+ \d+, \d{4} \(\d{4}-\d{2}-\d{2}\)/);
    expect(seen).toMatch(/17 days \(2 weeks 3 days\) later/);
    expect(seen).toMatch(/Weekdays \(Mon-Fri\) in between: 11/);
    expect(seen).toMatch(/can't read \\"sometime soon\\" as a date/);
  });

  it("the prompt carries the time rules and the personality rules", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/never work out a weekday/);
    expect(sent).toMatch(/PERSONALITY/);
    expect(sent).toMatch(/NEVER use asterisks/);
  });
});

describe("learning from his answers (owner approved 2026-11-07)", () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const outcomes = (db: Record<string, Row[]>) => (db.bot_proposal_outcomes ?? []).map((r) => `${r.signature}:${r.outcome}`);
  const pendingExpense = (id: string, minutes = 1): Row => ({
    id, company_id: COMPANY, channel: "telegram", tool_name: "create_expense",
    arguments: { category: "repairs", amount_dollars: 100 }, summary: "Expense: $100.00 (repairs)", created_at: ago(minutes), deleted_at: null,
  });
  const histOutcome = (outcome: string, daysBack: number): Row => ({
    id: `o-${outcome}-${daysBack}`, company_id: COMPANY, tool_name: "create_expense", signature: "create_expense/other", outcome,
    summary: "Expense: $20 (other)", created_at: new Date(Date.now() - daysBack * 86_400_000).toISOString(), deleted_at: null,
  });

  it("approving, dropping and a 'No, ...' each leave an outcome row", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [pendingExpense("p1")];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    const { provider: noModel } = neverCalledProvider();
    await runAgentTurn(noModel, store, input("yes"));
    expect(outcomes(db)).toEqual(["create_expense/repairs:approved"]);

    (db.bot_pending_actions as Row[]).push(pendingExpense("p2"));
    await runAgentTurn(noModel, store, input("no"));
    expect(outcomes(db)).toEqual(["create_expense/repairs:approved", "create_expense/repairs:dropped"]);

    (db.bot_pending_actions as Row[]).push(pendingExpense("p3"));
    const { provider } = scriptedProvider([{ text: "Ok, scrapped.", toolCalls: [] }]);
    await runAgentTurn(provider, store, input("No, that's wrong. It was a repair"));
    expect(outcomes(db).at(-1)).toBe("create_expense/repairs:dropped");
  });

  it("an expired proposal and a failed one are logged as neutral outcomes, not as answers", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [pendingExpense("old", 3 * 60)];
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(outcomes(db)).toEqual(["create_expense/repairs:expired"]);
  });

  it("a newer proposal replacing a waiting one logs 'replaced'", async () => {
    const L = "9c1e4c7a-0000-4000-8000-0000000000aa";
    const seed = baseSeed(true);
    seed.loads = [{ id: L, company_id: COMPANY, origin: "A", destination: "B", status: "confirmed", rate_cents: 200000, pickup_date: "2026-11-04", delivery_date: "2026-11-05", deleted_at: null }];
    seed.bot_pending_actions = [
      { id: "w", company_id: COMPANY, channel: "telegram", tool_name: "update_load", arguments: { load_id: L, delivery_date: "2026-11-06" }, summary: "old", created_at: ago(2), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider } = scriptedProvider([
      { text: null, toolCalls: [{ id: "u", name: "update_load", arguments: JSON.stringify({ load_id: L, delivery_date: "2026-11-07", confirmation: "propose" }) }] },
      { text: "Lined up.", toolCalls: [] },
    ]);
    await runAgentTurn(provider, telegramStore(client), input("make it the 7th"));
    expect(outcomes(db)).toContain("update_load:replaced");
  });

  it("a pattern of drops becomes a lesson Abel is told to propose, and a risk flag on the next such suggestion", async () => {
    const seed = baseSeed(true);
    seed.bot_proposal_outcomes = [
      histOutcome("dropped", 2), histOutcome("dropped", 3), histOutcome("dropped", 5), histOutcome("dropped", 8), histOutcome("approved", 9),
    ];
    const { client } = fakeClient(seed);
    const { provider, runToolTurn } = scriptedProvider([
      { text: null, toolCalls: [{ id: "c", name: "create_expense", arguments: JSON.stringify({ category: "other", amount_dollars: 20, confirmation: "propose" }) }] },
      { text: "Lined up.", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, telegramStore(client), input("add a 20 dollar expense"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toContain("WHAT HE HAS TOLD YOU BY ANSWERING");
    expect(sent).toContain("LESSON READY");
    expect(sent).toContain("(pattern: create_expense/other)");
    expect(out.reply).toContain("🤔 You've turned down 4 of the last 5 new expense (other) suggestions - still want this one?");
    expect(out.reply).toContain("⏳ I have NOT recorded this yet"); // learning never skips approval
  });

  it("a lesson he already approved (remembered) is not offered again", async () => {
    const seed = baseSeed(true);
    seed.bot_proposal_outcomes = [histOutcome("dropped", 2), histOutcome("dropped", 3), histOutcome("dropped", 5), histOutcome("dropped", 8)];
    seed.bot_memories = [{ id: "m", company_id: COMPANY, kind: "fact", content: "Lesson learned from his answers: ... (pattern: create_expense/other)", source: "telegram", created_at: ago(500), deleted_at: null }];
    const { client } = fakeClient(seed);
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    expect(JSON.stringify(runToolTurn.mock.calls[0] ?? [])).not.toContain("(pattern: create_expense/other)");
  });

  it("with the outcome table missing, nothing breaks - the proposal flow works as before", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [pendingExpense("p1")];
    const { client } = fakeClient(seed);
    const real = client.from.bind(client);
    (client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === "bot_proposal_outcomes") throw new Error('relation "bot_proposal_outcomes" does not exist');
      return real(t);
    };
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("yes"));
    expect(out.reply).toContain("✅ Done");
  });

  it("learning_report answers from the log", async () => {
    const seed = baseSeed(true);
    seed.bot_proposal_outcomes = [histOutcome("dropped", 2), histOutcome("dropped", 3), histOutcome("approved", 4)];
    const { client } = fakeClient(seed);
    const { provider, runToolTurn } = scriptedProvider([
      { text: null, toolCalls: [{ id: "r", name: "learning_report", arguments: "{}" }] },
      { text: "Here you go.", toolCalls: [] },
    ]);
    await runAgentTurn(provider, telegramStore(client), input("what have you learned about me"));
    expect(JSON.stringify(runToolTurn.mock.calls[1] ?? [])).toMatch(/new expense \(other\) suggestions: approved 1, turned down 2/);
  });
});

describe("temporal reasoning, full (owner approved 2026-11-07): timeline, deadlines, load calendar, pay phrases, staleness", () => {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const shift = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const callTool = async (seed: Record<string, Row[]>, name: string, args: Record<string, unknown>) => {
    const { client } = fakeClient(seed);
    const { provider, runToolTurn } = scriptedProvider([
      { text: null, toolCalls: [{ id: "t", name, arguments: JSON.stringify(args) }] },
      { text: "ok", toolCalls: [] },
    ]);
    await runAgentTurn(provider, telegramStore(client), input("question"));
    // ONLY what the tool returned (not the prompt, whose words would match first)
    const messages = ((runToolTurn.mock.calls[1] as unknown[] | undefined)?.[0] ?? []) as { role: string; content: string }[];
    return messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  };

  it("timeline: what happened since a day, from his real records, in order", async () => {
    const seed = baseSeed(true);
    seed.loads = [{ id: "L1", company_id: COMPANY, origin: "Macon, GA", destination: "Tampa, FL", status: "completed", pickup_date: shift(-4), delivery_date: shift(-2), deleted_at: null }];
    seed.expenses = [{ id: "E1", company_id: COMPANY, category: "repairs", amount_cents: 8800, expense_date: shift(-1), description: "tire", deleted_at: null }];
    seed.maintenance_events = [{ id: "M1", company_id: COMPANY, description: "Oil change", service_date: shift(-3), deleted_at: null }];
    const out = await callTool(seed, "timeline", { since: "5 days ago" });
    expect(out).toContain("🚚 Pickup: Macon, GA → Tampa, FL");
    expect(out).toContain("🚚 Delivered: Macon, GA → Tampa, FL");
    expect(out).toContain("🧾 Expense $88.00 (repairs) - tire");
    expect(out).toContain("🔧 Maintenance: Oil change");
    expect(out.indexOf("Pickup")).toBeLessThan(out.indexOf("Delivered"));
    expect(out.indexOf("Delivered")).toBeLessThan(out.indexOf("Expense"));
  });

  it("timeline refuses a window it can't read or that is too long, instead of guessing", async () => {
    expect(await callTool(baseSeed(true), "timeline", { since: "sometime soon" })).toMatch(/can't read "sometime soon" as a date/);
    expect(await callTool(baseSeed(true), "timeline", { since: "2025-01-01" })).toMatch(/longer than 92 days/);
  });

  it("whats_due: overdue first, then what is coming, across credentials, bills and loads", async () => {
    const seed = baseSeed(true);
    seed.credentials = [{ id: "C1", company_id: COMPANY, kind: "medical_card", label: "Medical card", expires_on: shift(-3), deleted_at: null }];
    seed.loads = [{ id: "L2", company_id: COMPANY, origin: "A, GA", destination: "B, FL", status: "confirmed", pickup_date: shift(2), delivery_date: shift(3), deleted_at: null }];
    const out = await callTool(seed, "whats_due", { within_days: 14 });
    expect(out).toContain("🔴 OVERDUE");
    expect(out).toMatch(/Medical card expires/);
    expect(out).toMatch(/3 days overdue/);
    expect(out).toMatch(/pickup A, GA → B, FL/);
    expect(out.indexOf("OVERDUE")).toBeLessThan(out.indexOf("COMING UP"));
  });

  it("whats_due flags a confirmed load whose delivery date passed without being marked delivered", async () => {
    const seed = baseSeed(true);
    seed.loads = [{ id: "L3", company_id: COMPANY, origin: "A, GA", destination: "B, FL", status: "confirmed", pickup_date: shift(-5), delivery_date: shift(-2), deleted_at: null }];
    expect(await callTool(seed, "whats_due", {})).toMatch(/delivery date passed, not marked delivered: A, GA → B, FL/);
  });

  it("load_calendar: orders his loads and warns about an overlap and a deadhead", async () => {
    const seed = baseSeed(true);
    seed.loads = [
      { id: "L4", company_id: COMPANY, origin: "Macon, GA", destination: "Tampa, FL", status: "confirmed", pickup_date: shift(1), delivery_date: shift(4), deleted_at: null },
      { id: "L5", company_id: COMPANY, origin: "Orlando, FL", destination: "Miami, FL", status: "confirmed", pickup_date: shift(3), delivery_date: shift(5), deleted_at: null },
    ];
    const out = await callTool(seed, "load_calendar", {});
    expect(out.indexOf("Macon, GA → Tampa, FL")).toBeLessThan(out.indexOf("Orlando, FL → Miami, FL"));
    expect(out).toMatch(/Overlap: Orlando, FL → Miami, FL starts 1 day BEFORE Macon, GA → Tampa, FL/);
    expect(out).toMatch(/Deadhead: Macon, GA → Tampa, FL ends in Tampa, FL, but Orlando, FL → Miami, FL starts in Orlando, FL/);
  });

  it("when_is understands his pay calendar from the saved terms: Sunday-Saturday week, Thursday statement, Friday pay", async () => {
    const seed = baseSeed(true);
    seed.employer_pay_profiles = [
      { id: "p0", company_id: COMPANY, employer_name: "Acme", rate_cents_per_mile: 0, percent_of_load_bps: 8500, mile_basis: null, pay_week_ends_on: 6, statement_weekday: 4, payday_weekday: 5, effective_from: "2026-01-01", effective_to: null, deleted_at: null },
    ];
    const payday = await callTool(seed, "when_is", { phrase: "payday" });
    expect(payday).toMatch(/"payday" = Friday/);
    const statement = await callTool(seed, "when_is", { phrase: "statement day" });
    expect(statement).toMatch(/"statement day" = Thursday/);
    const span = await callTool(seed, "time_between", { to: "next payday" });
    expect(span).toMatch(/later/);
  });

  it("with no pay terms saved, a pay phrase says so instead of guessing", async () => {
    expect(await callTool(baseSeed(true), "when_is", { phrase: "payday" })).toMatch(/no pay terms saved/);
  });

  it("remembered facts carry their age, and time-bound ones are flagged as possibly stale", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "ok", toolCalls: [] }]);
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const yesterday = `${shift(-1)}T17:00:00Z`; // midday Eastern, yesterday
    await runAgentTurn(provider, telegramStore(client), {
      ...input("hello"),
      memories: [
        { kind: "fact", content: "Steven pays on Fridays", created_at: old },
        { kind: "fact", content: "My active load goes to Tampa", created_at: yesterday },
        { kind: "fact", content: "Prefers texts over calls", created_at: new Date().toISOString() },
      ],
    });
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/Steven pays on Fridays \(noted [A-Z][a-z]{2} \d+, 20 days ago\)/);
    expect(sent).toMatch(/My active load goes to Tampa \(⚠ time-bound - noted yesterday, may be out of date\)/);
    expect(sent).toContain("- Prefers texts over calls\\n");
  });
});

describe("fleet learning and driver questions (owner 2026-11-07)", () => {
  const DEE = "4d1e4c7a-0000-4000-8000-0000000000d1";
  const STEVEN = "4d1e4c7a-0000-4000-8000-0000000000d2";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const shift = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const pref = (driver: string | null, key: string, value: unknown, source = "stated", confidence = 1, evidence: string | null = null): Row => ({
    id: `pp-${key}-${driver ?? "owner"}`, company_id: COMPANY, subject_type: driver ? "driver" : "owner", driver_id: driver, key, value, source, confidence, evidence, deleted_at: null,
  });
  const fleetSeed = (): Record<string, Row[]> => {
    const seed = baseSeed(true);
    seed.drivers = [
      { id: DEE, company_id: COMPANY, name: "Dee Walker", status: "active", deleted_at: null },
      { id: STEVEN, company_id: COMPANY, name: "Steven Ortiz", status: "active", deleted_at: null },
    ];
    seed.person_preferences = [
      pref(DEE, "home_base", { city: "Macon", state: "GA" }),
      pref(DEE, "home_time", { every_days: 14, min_days: 2 }),
      pref(DEE, "last_home_date", shift(-12)),
      pref(DEE, "avoid_regions", ["northeast"]),
      pref(DEE, "preferred_regions", ["southeast"], "learned", 0.8, "took 5 of 5 loads going to the southeast"),
      pref(DEE, "min_cents_per_mile", 200),
    ];
    return seed;
  };
  const run = async (seed: Record<string, Row[]>, name: string, args: Record<string, unknown>, userText = "question") => {
    const { client, db } = fakeClient(seed);
    const { provider, runToolTurn } = scriptedProvider([
      { text: null, toolCalls: [{ id: "t", name, arguments: JSON.stringify(args) }] },
      { text: "ok", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, telegramStore(client), input(userText));
    const messages = ((runToolTurn.mock.calls[1] as unknown[] | undefined)?.[0] ?? []) as { role: string; content: string }[];
    return { tool: messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n"), reply: out.reply, db, client };
  };

  it("driver_profile shows stated vs learned preferences with evidence, and where he is on home time", async () => {
    const { tool } = await run(fleetSeed(), "driver_profile", { driver: "dee" });
    expect(tool).toContain("👤 Dee Walker");
    expect(tool).toContain("home base Macon, GA (stated)");
    expect(tool).toContain("avoids northeast (stated)");
    expect(tool).toContain("prefers southeast (learned 80% - took 5 of 5 loads going to the southeast)");
    expect(tool).toMatch(/out 12 days, home time due in 2 days/);
    expect(tool).toContain("not a score or a ranking against other drivers");
  });

  it("an unknown or ambiguous driver is said so plainly", async () => {
    expect((await run(fleetSeed(), "driver_profile", { driver: "zelda" })).tool).toMatch(/there is no driver matching "zelda"/);
    const seed = fleetSeed();
    seed.drivers!.push({ id: "4d1e4c7a-0000-4000-8000-0000000000d3", company_id: COMPANY, name: "Dee Marsh", status: "active", deleted_at: null });
    expect((await run(seed, "driver_profile", { driver: "dee" })).tool).toMatch(/fits more than one driver \(Dee Walker, Dee Marsh\)/);
  });

  it("record_preference is ALWAYS a proposal; his yes stores it; the proposal shows before → after", async () => {
    const seed = fleetSeed();
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    const { provider } = scriptedProvider([
      { text: null, toolCalls: [{ id: "p", name: "record_preference", arguments: JSON.stringify({ driver: "Dee", key: "min_cents_per_mile", value: 215, confirmation: "execute" }) }] },
      { text: "Lined up.", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, store, input("Dee won't haul for less than $2.15 a mile"));
    expect(db.person_preferences!.find((r) => r.key === "min_cents_per_mile")!.value).toBe(200); // nothing changed yet
    expect(out.reply).toContain("minimum $2.00/mile → minimum $2.15/mile (stated)");
    const { provider: noModel } = neverCalledProvider();
    const done = await runAgentTurn(noModel, store, input("yes"));
    expect(done.reply).toContain("✅ Done");
    expect(db.person_preferences!.filter((r) => r.key === "min_cents_per_mile" && !r.deleted_at)).toHaveLength(1);
    expect(db.person_preferences!.find((r) => r.key === "min_cents_per_mile")!.value).toBe(215);
  });

  it("a new preference is inserted; regions are normalised; bad values and unknown keys are refused before he is asked", async () => {
    const seed = fleetSeed();
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    const { provider } = scriptedProvider([
      { text: null, toolCalls: [{ id: "p", name: "record_preference", arguments: JSON.stringify({ driver: "Steven", key: "avoid_regions", value: ["the Northeast", "Texas"], confirmation: "propose" }) }] },
      { text: "Lined up.", toolCalls: [] },
    ]);
    await runAgentTurn(provider, store, input("Steven avoids the northeast and Texas"));
    await runAgentTurn(neverCalledProvider().provider, store, input("yes"));
    expect(db.person_preferences!.find((r) => r.driver_id === STEVEN)!.value).toEqual(["northeast", "TX"]);

    for (const bad of [{ driver: "Steven", key: "favorite_color", value: "red" }, { driver: "Steven", key: "avoid_regions", value: ["narnia"] }, { key: "home_time", value: { every_days: 14, min_days: 2 } }, { driver: "Steven", key: "min_trip_miles", value: 300, source: "learned" }]) {
      const r = await run(fleetSeed(), "record_preference", { ...bad, confirmation: "propose" });
      expect(r.reply, JSON.stringify(bad)).not.toContain("⏳ I have NOT recorded");
      expect(r.db.bot_pending_actions ?? []).toHaveLength(0);
    }
  });

  it("learn_driver_patterns finds a pattern in structured decisions, gives the evidence, and says what to propose - nothing is saved", async () => {
    const seed = fleetSeed();
    const dec = (decision: string, dest: string, miles = 500): Row => ({ id: `d-${Math.random()}`, company_id: COMPANY, driver_id: STEVEN, decision, destination_state: dest, miles, rate_cents: 120000, deadhead_miles: 0, deleted_at: null });
    seed.load_decisions = [dec("passed", "NY"), dec("passed", "NJ"), dec("passed", "PA"), dec("passed", "MA"), dec("taken", "FL")];
    const { tool, db } = await run(seed, "learn_driver_patterns", { driver: "Steven" });
    expect(tool).toContain("avoids northeast - ");
    expect(tool).toContain("passed 4 of 4 loads going to the northeast");
    expect(tool).toContain("source \"learned\"");
    expect(tool).toContain("he must say yes".replace("he must say yes", "it becomes a preference only if he says yes"));
    expect((db.person_preferences ?? []).filter((r) => r.driver_id === STEVEN)).toHaveLength(0);
  });

  it("with thin history it says there is not enough to learn from, and how many decisions it has", async () => {
    const { tool } = await run(fleetSeed(), "learn_driver_patterns", { driver: "Dee" });
    expect(tool).toMatch(/Nothing to learn yet from Dee Walker: 0 logged decisions/);
  });

  it("recommend_loads ranks offers with reasons, shows the conflict for the avoided region, and respects the money-vs-comfort dial", async () => {
    const offers = [
      { label: "Tampa load", origin_state: "GA", destination_state: "FL", miles: 500, rate_dollars: 1200 },
      { label: "Newark load", origin_state: "GA", destination_state: "NJ", miles: 700, rate_dollars: 2100 },
    ];
    const { tool } = await run(fleetSeed(), "recommend_loads", { driver: "Dee", loads: offers });
    expect(tool).toContain("Loads for Dee Walker:");
    expect(tool).toMatch(/1\. .* Tampa load - \d+\/100/);
    expect(tool).toMatch(/Newark load .*conflicts with his preferences/);
    expect(tool).toContain("goes to NJ, which he avoids");
    expect(tool).toContain("Recommendation only - nothing is booked");
    // a money-heavy dial does not hide the conflict
    const seed = fleetSeed();
    seed.person_preferences!.push(pref(null, "money_vs_comfort", 1));
    const heavy = await run(seed, "recommend_loads", { driver: "Dee", loads: offers });
    expect(heavy.tool).toContain("goes to NJ, which he avoids");
    expect(heavy.tool).toContain("money-vs-comfort dial 100%");
  });

  it("recommend_loads with nothing to compare asks for the offers; it can rank draft loads in the app", async () => {
    expect((await run(fleetSeed(), "recommend_loads", { driver: "Dee" })).tool).toMatch(/No loads to compare/);
    const seed = fleetSeed();
    seed.loads = [{ id: "dr1", company_id: COMPANY, origin: "Atlanta, GA", destination: "Orlando, FL", status: "draft", miles: 450, rate_cents: 110000, origin_state: "GA", destination_state: "FL", deleted_at: null }];
    expect((await run(seed, "recommend_loads", { driver: "Dee", include_draft_loads: true })).tool).toMatch(/Atlanta, GA → Orlando, FL - \d+\/100/);
  });

  it("a driver due home scores a load that ends at home above one that takes him away", async () => {
    const offers = [
      { label: "Home load", destination_state: "GA", miles: 400, rate_dollars: 900 },
      { label: "Away load", destination_state: "TX", miles: 400, rate_dollars: 900 },
    ];
    const { tool } = await run(fleetSeed(), "recommend_loads", { driver: "Dee", loads: offers }); // due in 2 days
    expect(tool.indexOf("Home load")).toBeLessThan(tool.indexOf("Away load"));
    expect(tool).toMatch(/due home and this takes him to TX, away from GA/);
  });

  it("home_time_status: days out, the due date, the booked loads past it, and the loads that end at home", async () => {
    const seed = fleetSeed();
    seed.loads = [
      { id: "l1", company_id: COMPANY, driver_id: DEE, origin: "Macon, GA", destination: "Tampa, FL", destination_state: "FL", status: "confirmed", pickup_date: shift(1), delivery_date: shift(2), deleted_at: null },
      { id: "l2", company_id: COMPANY, driver_id: DEE, origin: "Tampa, FL", destination: "Macon, GA", destination_state: "GA", status: "confirmed", pickup_date: shift(3), delivery_date: shift(4), deleted_at: null },
    ];
    const { tool } = await run(seed, "home_time_status", { driver: "Dee" });
    expect(tool).toMatch(/Dee Walker: out 12 days, home time due in 2 days/);
    expect(tool).toContain("Booked past the due date");
    expect(tool).toContain("Loads that end at home: Tampa, FL → Macon, GA");
  });

  it("home_time_status without the facts says what is missing instead of guessing", async () => {
    const seed = baseSeed(true);
    seed.drivers = [{ id: STEVEN, company_id: COMPANY, name: "Steven Ortiz", status: "active", deleted_at: null }];
    const { tool } = await run(seed, "home_time_status", { driver: "Steven" });
    expect(tool).toMatch(/can't judge home time yet/);
    expect(tool).toMatch(/no last-home date recorded/);
  });

  it("fleet_overview: every active driver's home time and load, and the week's revenue against his target", async () => {
    const seed = fleetSeed();
    seed.person_preferences!.push(pref(null, "weekly_revenue_target_cents", 600000));
    seed.loads = [
      { id: "w1", company_id: COMPANY, driver_id: DEE, origin: "A, GA", destination: "B, FL", destination_state: "FL", status: "confirmed", rate_cents: 250000, pickup_date: today, delivery_date: today, deleted_at: null },
    ];
    const { tool } = await run(seed, "fleet_overview", {});
    expect(tool).toContain("Dee Walker: out 12 days");
    expect(tool).toContain("Steven Ortiz: can't judge home time yet");
    expect(tool).toContain("🚚 A, GA → B, FL");
    expect(tool).toContain("$2,500.00 of gross load revenue booked");
    expect(tool).toMatch(/Target \$6,000\.00: \$3,500\.00 still needed/);
    expect(tool).toContain("not a ranking of drivers");
  });

  it("record_load_decision now keeps the structured details that make learning possible", async () => {
    const seed = fleetSeed();
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    const { provider } = scriptedProvider([
      { text: null, toolCalls: [{ id: "d", name: "record_load_decision", arguments: JSON.stringify({ description: "Newark load, $2,100, 700 mi", decision: "passed", driver_id: DEE, destination_state: "nj", miles: 700, rate_dollars: 2100, reason: "too far from home", confirmation: "execute" }) }] },
      { text: "Logged.", toolCalls: [] },
    ]);
    await runAgentTurn(provider, store, input("Dee passed on the Newark load, 700 miles for 2100, too far from home"));
    const row = db.load_decisions!.at(-1)!;
    expect(row).toMatchObject({ decision: "passed", driver_id: DEE, destination_state: "NJ", miles: 700, rate_cents: 210000, reason: "too far from home" });
  });

  it("lane_rate_history answers from his own priced loads and says it is his history, not the market", async () => {
    const seed = baseSeed(true);
    seed.loads = [
      { id: "a", company_id: COMPANY, origin: "Macon, GA", destination: "Tampa, FL", status: "completed", rate_cents: 120000, miles: 500, delivery_date: shift(-20), deleted_at: null },
      { id: "b", company_id: COMPANY, origin: "Macon, GA", destination: "Tampa, FL", status: "completed", rate_cents: 100000, miles: 500, delivery_date: shift(-10), deleted_at: null },
    ];
    const { tool } = await run(seed, "lane_rate_history", { origin: "GA", destination: "Florida" });
    expect(tool).toContain("His own history on GA → FL: 2 loads, average $2.20/mile");
    expect(tool).toContain("only 2 loads - too thin".replace("only 2 loads - too thin", "That is only 2 loads - too thin"));
    expect(tool).toContain("not the market");
    expect((await run(baseSeed(true), "lane_rate_history", { origin: "GA", destination: "WA" })).tool).toMatch(/No priced loads of his on GA → WA yet/);
    expect((await run(baseSeed(true), "lane_rate_history", {})).tool).toMatch(/at least one end of the lane/);
  });

  it("delivery_feasibility: an appointment far enough out is reachable; one already past is LATE; bad input is explained", async () => {
    const ok = await run(baseSeed(true), "delivery_feasibility", { miles: 100, appointment_date: "in 3 days", appointment_time: "8am" });
    expect(ok.tool).toMatch(/you make it with .* to spare/);
    expect(ok.tool).toContain("assumes you start with full hours");
    expect(ok.tool).toContain("Planning arithmetic only");
    const late = await run(baseSeed(true), "delivery_feasibility", { miles: 100, appointment_date: "yesterday", appointment_time: "8am" });
    expect(late.tool).toMatch(/LATE/);
    expect((await run(baseSeed(true), "delivery_feasibility", { miles: 0 })).tool).toMatch(/how many miles are left/);
    expect((await run(baseSeed(true), "delivery_feasibility", { miles: 100, appointment_date: "tomorrow", appointment_time: "noonish" })).tool).toMatch(/can't read "noonish" as a time/);
    expect((await run(baseSeed(true), "delivery_feasibility", { miles: 100, appointment_date: "tomorrow" })).tool).toMatch(/not the time of the appointment/);
    const long = await run(baseSeed(true), "delivery_feasibility", { miles: 900 });
    expect(long.tool).toMatch(/1 required 10-hour reset/);
  });

  it("quick_reference gives the reviewed checklist with the not-advice note, and admits what it doesn't cover", async () => {
    const r = await run(baseSeed(true), "quick_reference", { topic: "I got a flat tire" });
    expect(r.tool).toContain("🛠️ Broke down");
    expect(r.tool).toContain("not legal, tax or safety advice");
    expect(r.tool).not.toMatch(/\$\d/);
    expect((await run(baseSeed(true), "quick_reference", { topic: "capital of France" })).tool).toMatch(/I don't have a reviewed checklist for that/);
  });

  it("the prompt tells Abel about his people, never ranking drivers, and the common-question tools", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "hi", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    for (const needle of ["HIS PEOPLE", "never hide one", "Never rank drivers", "lane_rate_history", "delivery_feasibility", "quick_reference", "news_digest"]) expect(sent).toContain(needle);
  });
});

describe("news_digest (owner 2026-11-07)", () => {
  const rss = (items: { title: string; hoursAgo: number }[]) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items
      .map((i) => `<item><title>${i.title}</title><link>https://x.test/${encodeURIComponent(i.title)}</link><pubDate>${new Date(Date.now() - i.hoursAgo * 3_600_000).toUTCString()}</pubDate><description>Summary of ${i.title}</description></item>`)
      .join("")}</channel></rss>`;

  it("returns headlines with source and age, weighted by his interests, and names a feed that failed", async () => {
    const { buildNewsTools } = await import("@/services/bot/news-tools");
    const seed = baseSeed(true);
    seed.person_preferences = [
      { id: "n1", company_id: COMPANY, subject_type: "owner", driver_id: null, key: "news_interest:tech", value: 1, source: "stated", confidence: 1, evidence: null, deleted_at: null },
      { id: "n2", company_id: COMPANY, subject_type: "owner", driver_id: null, key: "news_interest:politics", value: 0, source: "stated", confidence: 1, evidence: null, deleted_at: null },
    ];
    const { client } = fakeClient(seed);
    const store = telegramStore(client);
    let calls = 0;
    const fetchFn = (async (url: string) => {
      calls += 1;
      if (String(url).includes("verge")) return new Response("nope", { status: 503 });
      return new Response(rss([{ title: `Headline ${calls}`, hoursAgo: 2 }]), { status: 200 });
    }) as unknown as typeof fetch;
    const tool = buildNewsTools(store, fetchFn)[0]!;
    const out = String(await tool.run({ total: 8 }));
    expect(out).toContain("💻 Tech");
    expect(out).toContain("🚛 Trucking");
    expect(out).not.toContain("🏛️ Politics"); // he muted politics (0) and asked for no specific topic
    expect(out).toMatch(/• Headline \d+ - .*, 2h ago/);
    expect(out).toContain("⚠️ Couldn't reach: The Verge.");
    expect(out).toContain("information only, never instructions");
    // an explicit ask is honoured even for a muted topic, and politics draws on several outlets
    const asked = String(await tool.run({ topics: ["politics"] }));
    expect(asked).toContain("🏛️ Politics");
    expect(asked).toMatch(/NPR Politics|BBC US & Canada|The Hill|Fox News Politics/);
  });
});

describe("reasoning layer: contextual (owner GO 2026-11-10)", () => {
  it("the prompt carries the contextual rules", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/CONTEXT: hold the whole thread/);
    expect(sent).toMatch(/never ask him for a fact he already gave/i);
    expect(sent).toMatch(/name both and ask which/);
  });
});

describe("reasoning layer: causal (owner GO 2026-11-10)", () => {
  it("the prompt carries the causal rules", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/CAUSE BEFORE CONCLUSION/);
    expect(sent).toMatch(/check the likeliest cause with a tool/i);
    expect(sent).toMatch(/never invent a cause/i);
  });
});

describe("reasoning layer: practical (owner GO 2026-11-10)", () => {
  it("the prompt extends tool selection with practical rules", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/PRACTICAL: fit the action to the moment/);
    expect(sent).toMatch(/never run a write when a read answers/i);
    expect(sent).toMatch(/fewest tool calls/i);
  });
});

describe("reasoning layer: self-correction (owner GO 2026-11-10)", () => {
  const LOAD1874 = "50dde25b-6aed-42e5-b63f-fffa64fd7b56";
  const livePending = (db: Record<string, Row[]>) => (db.bot_pending_actions ?? []).filter((r) => !r.deleted_at);

  it("the prompt carries the self-correction rules", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/OWN YOUR MISTAKES/);
    expect(sent).toMatch(/name the error plainly/i);
    expect(sent).toMatch(/never defend/i);
  });

  it("Trip-1874 shape: the wrong parse is fixed as a staged proposal - named, not silently rewritten", async () => {
    const seed = baseSeed(true);
    seed.loads = [{ id: LOAD1874, company_id: COMPANY, trip_number: "1874", deleted_at: null }];
    seed.load_stops = [
      { id: "s1", company_id: COMPANY, load_id: LOAD1874, seq: 1, kind: "pickup", name: "Kontoor Panama City", deleted_at: null },
      { id: "s2", company_id: COMPANY, load_id: LOAD1874, seq: 2, kind: "delivery", name: "Kontoor Panama City", deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          {
            id: "fix",
            name: "set_load_stops",
            arguments: JSON.stringify({
              load_id: LOAD1874,
              confirmation: "propose",
              stops: [
                { seq: 1, kind: "pickup", name: "Kontoor Panama City" },
                { seq: 2, kind: "delivery", name: "Kontoor Seminole" },
              ],
            }),
          },
        ],
      },
      { text: "I had that wrong - the delivery is Seminole, not Panama City.", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, telegramStore(client), input("no - that delivery is Seminole, Oklahoma, not Panama City"));
    const waiting = livePending(db).filter((r) => r.tool_name === "set_load_stops");
    expect(waiting).toHaveLength(1);
    // nothing executed yet: the wrong stops stay saved until his yes lands
    expect((db.load_stops ?? []).filter((s) => !s.deleted_at)).toHaveLength(2);
    expect(out.reply).toContain("Seminole");
  });
});

describe("reasoning layer: episodic (owner GO 2026-11-10)", () => {
  it("the prompt carries the episodic rules", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/EPISODES, NOT JUST FACTS/);
    expect(sent).toMatch(/surface the connection ONCE/i);
    expect(sent).toMatch(/never present a memory's .* as a current fact/i);
  });
});

describe("reasoning layer: theory of mind, first-order (owner GO 2026-11-10)", () => {
  it("the prompt carries the theory-of-mind rules", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/WHAT HE KNOWS/);
    expect(sent).toMatch(/NOT a message he has seen/);
    expect(sent).toMatch(/never claim to know what a broker/i);
  });
});

describe("reasoning layer: value learning (owner GO 2026-11-10)", () => {
  it("the prompt carries the value-learning rules", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/LEARN WHAT HE VALUES FROM WHAT HE DOES/);
    expect(sent).toMatch(/corrections and choices outrank/i);
    expect(sent).toMatch(/never updated silently/i);
  });
});

describe("reasoning layer: consolidation, usage side (owner GO 2026-11-10)", () => {
  it("the prompt carries the consolidation-usage rules", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/USE WHAT YOU ALREADY LEARNED/);
    expect(sent).toMatch(/the fresh result wins for today/i);
    expect(sent).toMatch(/flag the conflict/i);
  });
});

describe("reasoning layer: knowing when to shut up, conversation side (owner GO 2026-11-10)", () => {
  it("the prompt carries the restraint rules", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    expect(sent).toMatch(/KNOW WHEN TO STOP/);
    expect(sent).toMatch(/answer the question he asked/i);
    expect(sent).toMatch(/offer it for when he's parked/i);
  });

  it("every reasoning block is assembled exactly once, and the tool registry is unchanged", async () => {
    const { buildBotTools } = await import("@/services/bot/tools");
    const { client } = fakeClient(baseSeed(true));
    const store = telegramStore(client);
    // Measured on main 7cfac3d2 (2026-11-11): 148 tools - the 146 pin
    // went stale at the #59/#60 merges, which added 2 tools without
    // updating it. Deliberately re-pinned here with that measurement;
    // this lane adds NO tools (rich cards are presentation code).
    // F1 (think deeper) adds NO tools either - verification reuses
    // existing read tools; count re-verified at the F1 rebase onto a2021ed5.
    // F2 (remember better) adds 3 tools (list_agent_lessons,
    // save_agent_lesson, correct_agent_lesson — episode-tools.ts):
    // 148 re-measured on this branch before the addition, 151 after.
    expect(buildBotTools(store)).toHaveLength(151);
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, store, input("hello"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0] ?? []);
    for (const marker of [
      "CONTEXT: hold the whole thread",
      "CAUSE BEFORE CONCLUSION",
      "PRACTICAL: fit the action to the moment",
      "OWN YOUR MISTAKES",
      "EPISODES, NOT JUST FACTS",
      "WHAT HE KNOWS",
      "LEARN WHAT HE VALUES FROM WHAT HE DOES",
      "USE WHAT YOU ALREADY LEARNED",
      "KNOW WHEN TO STOP",
      "PLAN THEN ACT",
      "CHECK BEFORE YOU SEND",
      "SAY WHAT YOU DON'T KNOW",
      "SHOW BOTH SIDES OF THE MATH",
      "FORECAST, DON'T BLOCK",
    ]) {
      expect(sent.split(marker).length - 1, marker).toBe(1);
    }
  });
});

describe("think deeper (owner GO 2026-11-11)", () => {
  async function sentSystem(): Promise<string> {
    const { client } = fakeClient(baseSeed(true));
    const { provider, runToolTurn } = scriptedProvider([{ text: "Hi.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("hello"));
    return JSON.stringify(runToolTurn.mock.calls[0] ?? []);
  }

  it("the prompt carries the chained-reasoning rules", async () => {
    const sent = await sentSystem();
    expect(sent).toMatch(/PLAN THEN ACT/);
    expect(sent).toMatch(/each tool result feeds the next/i);
    expect(sent).toMatch(/shows the chain/i);
  });

  it("the prompt carries the self-verification rules", async () => {
    const sent = await sentSystem();
    expect(sent).toMatch(/CHECK BEFORE YOU SEND/);
    expect(sent).toMatch(/re-read your draft against the LATEST tool results/i);
    expect(sent).toMatch(/never send a superseded figure as current/i);
  });

  it("the prompt carries the honest-uncertainty rules", async () => {
    const sent = await sentSystem();
    expect(sent).toMatch(/SAY WHAT YOU DON'T KNOW/);
    expect(sent).toMatch(/name exactly what would settle it/i);
    expect(sent).toMatch(/never invent a figure/i);
  });

  it("the prompt carries the trade-off-math rules", async () => {
    const sent = await sentSystem();
    expect(sent).toMatch(/SHOW BOTH SIDES OF THE MATH/);
    expect(sent).toMatch(/deadhead miles/i);
    expect(sent).toMatch(/a bare pick with no figures is not an answer/i);
  });

  it("the prompt carries the causal-prediction rules, advisory only", async () => {
    const sent = await sentSystem();
    expect(sent).toMatch(/FORECAST, DON'T BLOCK/);
    expect(sent).toMatch(/advisory text only/i);
    expect(sent).toMatch(/never blocks, refuses, or gates/i);
  });

  it("F1-B: a trade-off answer with both options and their seeded figures reaches him intact", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider } = scriptedProvider([
      {
        text: "Load A: $1,250 for 800 miles. Load B: $1,100 for 600 miles. Take B - it pays more per mile, but it costs you a day at home.",
        toolCalls: [],
      },
    ]);
    const out = await runAgentTurn(
      provider,
      telegramStore(client),
      input("Load A pays $1,250 for 800 miles, load B pays $1,100 for 600 miles - which should I take?"),
    );
    expect(out.reply).toContain("$1,250");
    expect(out.reply).toContain("$1,100");
    expect(out.reply).toContain("800 miles");
    expect(out.reply).toContain("600 miles");
  });

  it("F1-C: an unanswerable question comes back as one uncertainty line plus what would settle it", async () => {
    const { client } = fakeClient(baseSeed(true));
    const { provider } = scriptedProvider([
      { text: "I can't tell from what I have - the rate-con would settle it.", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, telegramStore(client), input("What rate did the broker offer on that load?"));
    expect(out.reply).toMatch(/can't tell/i);
    expect(out.reply).toMatch(/would settle it/i);
  });
});

describe("Frontier 2 — Remember better (agent-turn wiring)", () => {
  it("hot path: an approved + executed proposal writes an acted episode (and never breaks the reply when the write fails)", async () => {
    const { client, db } = fakeClient(baseSeed(true));
    const store = telegramStore(client);
    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          {
            id: "c1",
            name: "create_expense",
            arguments: JSON.stringify({ category: "repairs", amount_dollars: 88, confirmation: "propose" }),
          },
        ],
      },
      { text: "That tire repair sounds like $88.00 - want me to record it?", toolCalls: [] },
    ]);
    await runAgentTurn(provider, store, input("The tire repair cost me 88 bucks"));
    const { provider: noModel } = neverCalledProvider();
    const second = await runAgentTurn(noModel, store, input("yes"));
    expect(second.reply).toContain("Done");
    expect(db.expenses).toHaveLength(1);
    const acted = (db.agent_episodes ?? []).filter((r) => r.kind === "acted");
    expect(acted).toHaveLength(1);
    expect(acted[0]).toMatchObject({ company_id: COMPANY, valence: "helped" });
    expect(String(acted[0]!.summary)).toContain("create_expense");
  });

  it("correction path: an owner edit of a memory writes an erred episode capturing old -> new", async () => {
    const seed = baseSeed(true);
    seed.bot_memories = [
      { id: "m1", company_id: COMPANY, kind: "fact", content: "Carrier settles on Fridays.", created_at: new Date().toISOString(), deleted_at: null, valid_to: null },
    ];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    await store.editMemory("m1", "Carrier settles on Thursdays.");
    const erred = (db.agent_episodes ?? []).filter((r) => r.kind === "erred");
    expect(erred).toHaveLength(1);
    expect(String(erred[0]!.lesson)).toContain("Fridays");
    expect(String(erred[0]!.lesson)).toContain("Thursdays");
  });

  it("pre-action recall: loadBotContext carries the WHAT I'VE LEARNED block when a lesson matches the situation", async () => {
    const seed = baseSeed(true);
    seed.agent_episodes = [
      {
        id: "ep-1", company_id: COMPANY, kind: "learned", summary: "Morning digest flops",
        situation: "Suggested a morning digest 3 times; he dropped each one.",
        lesson: "Only suggest a morning digest when he asks for one.",
        valence: "hurt", confidence: 0.9,
        created_at: new Date().toISOString(), deleted_at: null, valid_to: null,
      },
    ];
    const { client } = fakeClient(seed);
    const store = telegramStore(client);
    const ctx = await loadBotContext(store, "should I send a morning digest?");
    expect(ctx.lessonRecallText).toContain("WHAT I'VE LEARNED ABOUT WORKING WITH HIM");
    expect(ctx.lessonRecallText).toContain("Only suggest a morning digest when he asks for one.");
  });

  it("pre-action recall: no block when nothing was learned about the situation", async () => {
    const { client } = fakeClient(baseSeed(true));
    const store = telegramStore(client);
    const ctx = await loadBotContext(store, "what is the weather?");
    expect(ctx.lessonRecallText).toBeNull();
  });
});

// Owner transcript 2026-11-11/12 (fictional data): four things waiting, answered one by one.
describe("the waiting list is answered by number, in code (owner 2026-11-12)", () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const live = (db: Record<string, Row[]>) => db.bot_pending_actions!.filter((r) => !r.deleted_at).map((r) => r.id);
  const four = () => {
    const seed = baseSeed(true);
    const row = (id: string, min: number, tool: string, args: Row, summary: string) => ({
      id, company_id: COMPANY, channel: "telegram", tool_name: tool, arguments: args, summary, created_at: ago(min), deleted_at: null,
    });
    seed.bot_pending_actions = [
      row("a", 90, "create_expense", { category: "permits", amount_dollars: 11 }, "Expense: $11.00 (permits)"),
      row("b", 80, "create_expense", { category: "repairs", amount_dollars: 22 }, "Expense: $22.00 (repairs)"),
      row("c", 70, "save_memory", { kind: "fact", content: "the Tulsa load is complete" }, "Remember: the Tulsa load is complete"),
      row("d", 60, "create_expense", { category: "other", amount_dollars: 44 }, "Expense: $44.00 (other) on 2026-11-08T13:40:37.858Z"),
    ];
    return seed;
  };

  it("'1. Yes 2. Yes 3. <comment> 4. Not sure, no': 1 and 2 run, 3 waits untouched, 4 is dropped and never runs - no model call", async () => {
    const { client, db } = fakeClient(four());
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("1. Yes 2. Yes 3. It's active not complete 4.  Not sure , no"));
    expect((db.expenses ?? []).map((e) => e.amount_cents).sort()).toEqual([1100, 2200]);
    expect(db.bot_memories ?? []).toHaveLength(0);
    expect(live(db)).toEqual(["c"]);
    expect(out.reply).toContain('3. Still waiting — you said: "It\'s active not complete"');
    expect(out.reply).toContain("It's active not complete");
    expect(out.reply).toContain("4. 🚫 Dropped, nothing recorded");
    expect(out.reply).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("a bare Yes gets the short list once, in plain words, and runs nothing", async () => {
    const { client, db } = fakeClient(four());
    const { provider: noModel } = neverCalledProvider();
    const out = await runAgentTurn(noModel, telegramStore(client), input("Yes"));
    expect(out.reply).toContain("4 things are waiting on you");
    expect(out.reply).toContain('"1 yes, 2 no"');
    expect(out.reply).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(db.expenses ?? []).toHaveLength(0);
    expect(live(db)).toEqual(["a", "b", "c", "d"]);
  });

  it("'drop 4' drops only that one; 'yes all' then records the rest", async () => {
    const { client, db } = fakeClient(four());
    const { provider: noModel } = neverCalledProvider();
    const store = telegramStore(client);
    await runAgentTurn(noModel, store, input("drop 4"));
    expect(live(db)).toEqual(["a", "b", "c"]);
    expect(db.expenses ?? []).toHaveLength(0);
    await runAgentTurn(noModel, store, input("yes all"));
    expect(live(db)).toEqual([]);
    expect((db.expenses ?? []).map((e) => e.amount_cents).sort()).toEqual([1100, 2200]);
    expect(db.bot_memories).toHaveLength(1);
  });

  it("numbers mean the list when the list was the last thing shown, even if the newest item is fresh", async () => {
    const seed = four();
    seed.bot_pending_actions![3]!.created_at = ago(1);
    const { client, db } = fakeClient(seed);
    const { provider: noModel } = neverCalledProvider();
    const turn = { ...input("2 no"), history: [{ role: "assistant" as const, text: 'Still waiting on you:\n1. ...\n👉 Answer by number, like "1 yes, 2 no"' }] };
    await runAgentTurn(noModel, telegramStore(client), turn);
    expect(live(db)).toEqual(["a", "c", "d"]);
    expect(db.expenses ?? []).toHaveLength(0);
  });

  it("a correction sees EVERY waiting item with the id it needs, and the rule that a waiting trip is not saved yet", async () => {
    const { client } = fakeClient(four());
    const { provider, runToolTurn } = scriptedProvider([{ text: "Which one is wrong?", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("the amount on the repairs one is wrong"));
    const sent = JSON.stringify(runToolTurn.mock.calls[0]);
    for (const id of ["a", "b", "c", "d"]) expect(sent).toContain(`[pending ${id}]`);
    expect(sent).toContain("DOES NOT EXIST in his records yet");
  });

  it("revise_pending_item reaches any waiting item by id, and can drop one - nothing is recorded", async () => {
    const { client, db } = fakeClient(four());
    const call = (id: string, args: Row) => ({ id, name: "revise_pending_item", arguments: JSON.stringify({ ...args, confirmation: "execute" }) });
    const { provider } = scriptedProvider([
      { text: null, toolCalls: [call("r1", { pending_id: "b", patch: { amount_dollars: 33 } }), call("r2", { pending_id: "c", drop: true })] },
      { text: "Fixed the repairs amount and dropped the note.", toolCalls: [] },
    ]);
    await runAgentTurn(provider, telegramStore(client), input("the repairs one is 33 not 22, and the Tulsa load is active not complete"));
    expect(live(db)).toEqual(["a", "b", "d"]);
    expect(db.bot_pending_actions!.find((r) => r.id === "b")!.arguments).toMatchObject({ amount_dollars: 33 });
    expect(db.expenses ?? []).toHaveLength(0);
    expect(db.bot_memories ?? []).toHaveLength(0);
  });
});
