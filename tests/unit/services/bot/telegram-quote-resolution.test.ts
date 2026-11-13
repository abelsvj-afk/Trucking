// Telegram D4 quote resolution (Telegram review 2026-11-12): the
// quote IS the pointer. Against the same in-memory fake Supabase
// client as agent-turn.test.ts (harness copied from that file - no
// network):
// - record + lookup round-trip keeps rendered order.
// - a quoted YES/NO applies to the QUOTED group only - the other
//   waiting group is untouched.
// - a quoted CORRECTION goes to the model, quote-scoped: when the
//   model tries to execute the pending write directly, the guard
//   refuses it and nothing is recorded.
// - a quote of a message with no mapping executes nothing.
// - several groups in one quoted message ask "which one?", and a
//   numbered answer resolves against THAT message's list.
// - unquoted answers behave exactly as before.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAgentTurn } from "@/services/bot/agent-turn";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { recordQuoteTargets, lookupQuoteTargets } from "@/services/bot/quote-targets";
import type { BotChatInput } from "@/services/ai/bot-chat";
import type {
  AiToolTurnResult,
  AgentCapableProvider,
} from "@/services/ai/provider";

const COMPANY = "company-1";
const CHAT = "8975172276";

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
    telegram_quote_targets: [],
    driver_positions: [],
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

function quoteInput(userText: string, messageId: number): BotChatInput {
  return { ...input(userText), chatId: CHAT, replyToMessageId: messageId };
}

function telegramStore(client: SupabaseClient): BotBrainStore {
  return createBotStore(client, COMPANY, "telegram");
}

/** Ids of the pending rows still open (not soft-deleted). */
function openPendingIds(db: Record<string, Row[]>): string[] {
  return (db.bot_pending_actions ?? []).filter((r) => !r.deleted_at).map((r) => String(r.id));
}

const NOW = () => new Date().toISOString();
const DUTY_START = new Date(Date.now() - 60_000).toISOString();

function expenseRow(id: string) {
  return {
    id,
    company_id: COMPANY,
    channel: "telegram",
    tool_name: "create_expense",
    arguments: { category: "repairs", amount_dollars: 88 },
    summary: "Expense: $88.00 (repairs)",
    created_at: NOW(),
    deleted_at: null,
  };
}

function dutyRow(id: string) {
  return {
    id,
    company_id: COMPANY,
    channel: "telegram",
    tool_name: "log_duty_status",
    arguments: { duty_status: "driving", started_at: DUTY_START },
    summary: "Duty status: driving (paper-log helper)",
    created_at: NOW(),
    deleted_at: null,
  };
}

describe("quote-target mapping round-trip", () => {
  it("records (message -> groups) and looks them up in rendered order", async () => {
    const { client } = fakeClient(baseSeed(true));
    expect(await recordQuoteTargets(client, COMPANY, CHAT, [100], ["group-a", "group-b"])).toBe(true);
    expect(await lookupQuoteTargets(client, COMPANY, CHAT, 100)).toEqual(["group-a", "group-b"]);
    // A message that rendered nothing has no mapping (empty, not an error).
    expect(await lookupQuoteTargets(client, COMPANY, CHAT, 999)).toEqual([]);
    // One chunk id per split reply: quoting any chunk resolves.
    expect(await recordQuoteTargets(client, COMPANY, CHAT, [101, 102], ["group-a"])).toBe(true);
    expect(await lookupQuoteTargets(client, COMPANY, CHAT, 102)).toEqual(["group-a"]);
  });
});

describe("runAgentTurn - quoted answers bind to the quoted group only", () => {
  it("a quoted NO declines only that group - the other stays waiting", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [expenseRow("a"), dutyRow("b")];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    await recordQuoteTargets(client, COMPANY, CHAT, [100], ["a"]);
    const { provider: noModel, runToolTurn } = neverCalledProvider();
    const out = await runAgentTurn(noModel, store, quoteInput("No", 100));
    expect(runToolTurn).not.toHaveBeenCalled();
    expect(out.reply).toContain("Cancelled");
    expect(openPendingIds(db)).toEqual(["b"]);
    expect(db.expenses ?? []).toHaveLength(0);
    expect(db.duty_logs ?? []).toHaveLength(0);
  });

  it("a quoted YES executes only that group - the other stays waiting", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [expenseRow("a"), dutyRow("b")];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    await recordQuoteTargets(client, COMPANY, CHAT, [100], ["a"]);
    const { provider: noModel, runToolTurn } = neverCalledProvider();
    const out = await runAgentTurn(noModel, store, quoteInput("Yes", 100));
    expect(runToolTurn).not.toHaveBeenCalled();
    expect(out.reply).toContain("Done");
    expect(out.reply).toContain("$88.00");
    expect(db.expenses).toHaveLength(1);
    expect(db.expenses![0]).toMatchObject({ category: "repairs", amount_cents: 8800 });
    expect(db.duty_logs ?? []).toHaveLength(0);
    expect(openPendingIds(db)).toEqual(["b"]);
  });

  it("a quote of a message with no mapping executes nothing on a bare YES", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [expenseRow("a"), dutyRow("b")];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    const { provider: noModel, runToolTurn } = neverCalledProvider();
    const out = await runAgentTurn(noModel, store, quoteInput("Yes", 999));
    expect(runToolTurn).not.toHaveBeenCalled();
    expect(out.reply).toContain("didn't have anything waiting");
    expect(db.expenses ?? []).toHaveLength(0);
    expect(db.duty_logs ?? []).toHaveLength(0);
    expect(openPendingIds(db)).toEqual(["a", "b"]);
  });

  it("a quoted correction goes to the model, and the guard refuses a direct execute of the pending write", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [expenseRow("a"), dutyRow("b")];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    await recordQuoteTargets(client, COMPANY, CHAT, [100], ["b"]);
    // The D3 shape: the model tries to execute the pending duty
    // write itself instead of waiting for his answer. The turn
    // scripts it twice (the first call may just load the tool into
    // the turn's selection) and then answers in words.
    const executeDuty = {
      text: null,
      toolCalls: [
        {
          id: "c1",
          name: "log_duty_status",
          arguments: JSON.stringify({ duty_status: "driving", started_at: DUTY_START, confirmation: "execute" }),
        },
      ],
    };
    const { provider, runToolTurn } = scriptedProvider([
      executeDuty,
      executeDuty,
      { text: "Understood — I'll leave that proposal waiting as it is.", toolCalls: [] },
    ]);
    const out = await runAgentTurn(provider, store, quoteInput("actually make it on duty from 9am", 100));
    expect(runToolTurn).toHaveBeenCalled();
    expect(out.reply).toContain("leave that proposal waiting");
    // Nothing was recorded anywhere: the guard refused the execute.
    expect(db.duty_logs ?? []).toHaveLength(0);
    expect(db.expenses ?? []).toHaveLength(0);
    expect(openPendingIds(db)).toEqual(["a", "b"]);
  });

  it("several groups in one quoted message ask which one, and a numbered answer resolves against that list", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [expenseRow("a"), dutyRow("b")];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    await recordQuoteTargets(client, COMPANY, CHAT, [100], ["a", "b"]);
    const { provider: noModel } = neverCalledProvider();
    const asked = await runAgentTurn(noModel, store, quoteInput("yes", 100));
    expect(asked.reply).toContain("Which one?");
    expect(asked.reply).toContain("$88.00");
    expect(asked.reply).toContain("Duty status");
    expect(db.expenses ?? []).toHaveLength(0);
    expect(openPendingIds(db)).toEqual(["a", "b"]);

    const answered = await runAgentTurn(noModel, store, quoteInput("1 yes, 2 no", 100));
    expect(db.expenses).toHaveLength(1);
    expect(db.expenses![0]).toMatchObject({ category: "repairs", amount_cents: 8800 });
    expect(db.duty_logs ?? []).toHaveLength(0);
    expect(openPendingIds(db)).toEqual([]);
    expect(answered.reply).toContain("$88.00");
  });
});

describe("runAgentTurn - unquoted answers are unchanged", () => {
  it("a bare yes with one pending group still executes it", async () => {
    const seed = baseSeed(true);
    seed.bot_pending_actions = [expenseRow("a")];
    const { client, db } = fakeClient(seed);
    const store = telegramStore(client);
    const { provider: noModel, runToolTurn } = neverCalledProvider();
    const out = await runAgentTurn(noModel, store, input("yes"));
    expect(runToolTurn).not.toHaveBeenCalled();
    expect(out.reply).toContain("Done");
    expect(db.expenses).toHaveLength(1);
    expect(openPendingIds(db)).toEqual([]);
  });
});
