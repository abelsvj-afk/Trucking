// Abel Job Brain (§11) through the agent loop, against an in-memory
// fake Supabase client (harness pattern copied from agent-turn.test.ts):
// - the knowledge brief is IN the assembled system prompt, and the
//   pay advisor is among the tools on offer (prompt assembly);
// - a pay question is answered by the evaluate_pay_offer TOOL - the
//   figures in the reply trace to the tool's code-computed output;
// - a learned PERSON PROFILE goes through propose -> yes like every
//   other write: nothing is stored before the yes, and the profile
//   is retrievable through the people module afterwards.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAgentTurn } from "@/services/bot/agent-turn";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { profilesForPerson } from "@/services/bot/people";
import type { BotChatInput } from "@/services/ai/bot-chat";
import type { BotMemoryRow } from "@/services/telegram/context";
import type {
  AiAgentMessage,
  AiToolSpec,
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
    ai_capability_settings: [
      { id: "cs-1", company_id: COMPANY, capability: "bot_chat", enabled: true, deleted_at: null },
    ],
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

function capturingProvider(turns: AiToolTurnResult[]) {
  let index = 0;
  const calls: { messages: AiAgentMessage[]; tools: AiToolSpec[] }[] = [];
  const runToolTurn = vi.fn(async (messages: AiAgentMessage[], tools: AiToolSpec[]) => {
    calls.push({ messages, tools });
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
  return { provider, calls };
}

function neverCalledProvider() {
  const provider: AgentCapableProvider = {
    complete: async () => {
      throw new Error("the model must not be called on this path");
    },
    runToolTurn: async () => {
      throw new Error("the model must not be called on this path");
    },
  };
  return provider;
}

function input(userText: string): BotChatInput {
  return { userText, history: [], snapshotText: null, instructions: [], memories: [] };
}

function telegramStore(client: SupabaseClient): BotBrainStore {
  return createBotStore(client, COMPANY, "telegram");
}

describe("Job Brain prompt assembly (§11)", () => {
  it("puts the job knowledge and the pay tool in front of the model on every turn", async () => {
    const { client } = fakeClient(baseSeed());
    const store = telegramStore(client);
    const { provider, calls } = capturingProvider([{ text: "Morning.", toolCalls: [] }]);

    await runAgentTurn(provider, store, input("Morning - first pickup is at 9"));

    const system = calls[0]!.messages.find((m) => m.role === "system");
    expect(system?.content).toContain("JOB KNOWLEDGE");
    expect(system?.content).toMatch(/Seal mismatch/);
    expect(system?.content).toMatch(/15\.3%/);
    expect(system?.content).toContain("evaluate_pay_offer");
    const toolNames = calls[0]!.tools.map((t) => t.name);
    expect(toolNames).toContain("evaluate_pay_offer");
    const saveMemory = calls[0]!.tools.find((t) => t.name === "save_memory");
    const kindEnum = (saveMemory?.parameters as { properties?: { kind?: { enum?: string[] } } })
      ?.properties?.kind?.enum;
    expect(kindEnum).toContain("person_profile");
    expect(kindEnum).toContain("business_fact");
  });
});

describe("Job Brain pay coaching (§11)", () => {
  it("answers a pay question through the evaluate_pay_offer tool - figures trace to code output", async () => {
    const { client } = fakeClient(baseSeed());
    const store = telegramStore(client);
    const { provider, calls } = capturingProvider([
      {
        text: null,
        toolCalls: [
          {
            id: "c1",
            name: "evaluate_pay_offer",
            arguments: JSON.stringify({
              structure: "percentage_gross",
              percentage: 25,
              load_gross_dollars: 6000,
              loaded_miles: 2400,
              empty_miles: 300,
              days_on_load: 4,
              employment: "w2",
              fuel_paid_by: "owner",
              detention_terms_known: true,
            }),
          },
        ],
      },
      { text: "That grades FAIR - $1500.00 for the load, $0.56 a mile on all miles.", toolCalls: [] },
    ]);

    const out = await runAgentTurn(
      provider,
      store,
      input("Steven offered 25% of gross on a $6000 load, 2400 loaded and 300 empty, 4 days. W2, he pays fuel. Fair?"),
    );
    expect(out.reply).toContain("FAIR");
    expect(out.reply).toContain("$1500.00");
    // The tool result the model saw carries the code-computed verdict.
    const toolMessages = calls[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.content).join(" ")).toContain("PAY EVALUATION");
    expect(toolMessages.map((m) => m.content).join(" ")).toContain("Verdict: FAIR");
  });
});

describe("Job Brain people learning (§11)", () => {
  it("stores a proposed person profile only after the owner's yes, and finds it again by name", async () => {
    const { client, db } = fakeClient(baseSeed());
    const store = telegramStore(client);
    const profileLine = "PERSON — Steven | role: truck owner | Settles pay on Fridays. Prefers morning pickups.";
    const { provider } = capturingProvider([
      {
        text: null,
        toolCalls: [
          {
            id: "c1",
            name: "save_memory",
            arguments: JSON.stringify({
              kind: "person_profile",
              content: profileLine,
              confirmation: "propose",
            }),
          },
        ],
      },
      { text: "Want me to remember that profile of Steven?", toolCalls: [] },
    ]);

    const first = await runAgentTurn(provider, store, input("Steven settles pay on Fridays and likes morning pickups"));
    expect(first.reply).toContain("NOT recorded");
    expect(db.bot_memories).toHaveLength(0);

    const second = await runAgentTurn(neverCalledProvider(), store, input("yes"));
    expect(second.reply).toContain("Done");
    expect(db.bot_memories).toHaveLength(1);
    expect(db.bot_memories![0]).toMatchObject({ kind: "person_profile", content: profileLine });

    const memories = (db.bot_memories ?? []).map(
      (row): BotMemoryRow => ({
        kind: row.kind as BotMemoryRow["kind"],
        content: String(row.content),
        created_at: String(row.created_at),
      }),
    );
    const profiles = profilesForPerson(memories, "Steven");
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ name: "Steven", role: "truck owner" });
  });
});
