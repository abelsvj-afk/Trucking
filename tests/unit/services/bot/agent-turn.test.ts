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
  private payload: Row | null = null;
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
  insert(payload: Row) {
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
