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
import { BOT_DISABLED_REPLY, runAgentTurn } from "@/services/bot/agent-turn";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import type { BotChatInput } from "@/services/ai/bot-chat";
import type {
  AiToolTurnResult,
  AgentCapableProvider,
} from "@/services/ai/provider";

const COMPANY = "company-1";

type Row = Record<string, unknown>;

type Filter = { op: "eq" | "is" | "gte" | "in" | "ilike"; col: string; val: unknown };

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
  in(col: string, val: unknown) {
    this.filters.push({ op: "in", col, val });
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
    expect(out.reply).toContain("not sure which one");
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
    expect(out.reply).toContain("Still waiting for your yes/no");
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
