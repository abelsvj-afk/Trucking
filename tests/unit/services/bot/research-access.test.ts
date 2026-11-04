// R-6 (Research Intelligence design D-7/D-5): Abel's conversational
// access to the Deep Research engine, against an in-memory fake
// Supabase client:
// - list_research_briefings / get_research_briefing read the Stage-5
//   engine's table and LABEL it Deep Research, while
//   list_industry_briefings labels itself the industry-intelligence
//   engine - the two engines never blur in an answer;
// - queue_research inserts exactly the manual row the app's
//   research-now route writes (own company, manual, queued);
// - request_pretrip_photos / dismiss_research_request drive the
//   research_requests plumbing from conversation;
// - a pending photo ask surfaces as a turn context block (the ask
//   side of the D-5 contract) with the load's lane resolved.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAgentTurn } from "@/services/bot/agent-turn";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { buildBotTools } from "@/services/bot/tools";
import type { BotChatInput } from "@/services/ai/bot-chat";
import type { AgentCapableProvider } from "@/services/ai/provider";

const COMPANY = "company-1";
const LOAD_ID = "16161616-1616-4616-8616-161616161616";
const BRIEFING_ID = "26262626-2626-4626-8626-262626262626";
const REQUEST_ID = "36363636-3636-4636-8636-363636363636";

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
        return typeof value === "string" && typeof f.val === "string"
          ? value >= f.val
          : Number(value) >= Number(f.val);
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

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
    private nextStamp: () => string,
    private nextId: () => string,
  ) {}

  select() {
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

  private matched(): Row[] {
    const rows = (this.db[this.table] ?? []).filter((r) => matches(r, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      rows.sort((a, b) => {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return this.limitN != null ? rows.slice(0, this.limitN) : rows;
  }

  private execute(): { data: unknown; error: null } {
    if (this.op === "insert") {
      const row: Row = {
        id: this.nextId(),
        created_at: this.nextStamp(),
        ...this.payload,
      };
      (this.db[this.table] ??= []).push(row);
      return { data: row, error: null };
    }
    if (this.op === "update") {
      const rows = this.matched();
      for (const row of rows) Object.assign(row, this.payload);
      return { data: rows, error: null };
    }
    return { data: this.matched(), error: null };
  }

  async single() {
    const { data, error } = this.execute();
    return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
  }
  async maybeSingle() {
    const rows = this.matched();
    return { data: rows[0] ?? null, error: null };
  }
  then(resolve: (v: { data: unknown; error: null }) => void) {
    resolve(this.execute());
  }
}

function fakeClient(seed: Record<string, Row[]>) {
  const db: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) db[table] = rows.map((r) => ({ ...r }));
  let tick = 0;
  const base = Date.now();
  const nextStamp = () => new Date(base + tick++ * 1000).toISOString();
  let idSeq = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`;
  const client = {
    from: (table: string) => new FakeQuery(db, table, nextStamp, nextId),
  } as unknown as SupabaseClient;
  return { client, db };
}

function baseSeed(): Record<string, Row[]> {
  return {
    companies: [{ id: COMPANY, ai_globally_disabled: false, deleted_at: null }],
    ai_capability_settings: [
      { id: "cs-1", company_id: COMPANY, capability: "bot_chat", enabled: true, deleted_at: null },
    ],
    bot_pending_actions: [],
    telegram_messages: [],
    bot_memories: [],
    loads: [
      {
        id: LOAD_ID,
        company_id: COMPANY,
        origin: "Melbourne, FL",
        destination: "Atlanta, GA",
        status: "confirmed",
        deleted_at: null,
      },
    ],
    industry_briefings: [
      {
        id: "ib-1",
        company_id: COMPANY,
        summary: "Diesel up 15 cents in the Southeast this week.",
        confidence: "medium",
        generated_at: "2026-11-02T06:00:00.000Z",
        dismissed_at: null,
      },
    ],
    research_briefings: [
      {
        id: BRIEFING_ID,
        company_id: COMPANY,
        topic: "fuel",
        title: "Diesel spike hits the Southeast",
        headline: "PADD 1 diesel jumped 9 cents week over week.",
        findings: [
          { claim: "PADD 1 diesel rose 9 cents WoW", source_title: "EIA weekly", source_url: "https://eia.gov/x" },
        ],
        what_changed: "Regional spread widened beyond the 3% trigger.",
        counter_move: "Fuel in Georgia before crossing into Florida.",
        takeaway: "Top off early this week.",
        unverified: ["One news report of station outages is unconfirmed"],
        sources: [{ title: "EIA weekly", url: "https://eia.gov/x" }],
        confidence: "high",
        created_at: "2026-11-02T07:00:00.000Z",
        dismissed_at: null,
      },
    ],
    research_runs: [],
    research_requests: [],
  };
}

function store(client: SupabaseClient): BotBrainStore {
  return createBotStore(client, COMPANY, "telegram");
}

function tool(s: BotBrainStore, name: string) {
  const found = buildBotTools(s).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

describe("the two briefing engines, labeled distinctly", () => {
  it("list_research_briefings labels Deep Research and carries the counter-move", async () => {
    const { client } = fakeClient(baseSeed());
    const out = await tool(store(client), "list_research_briefings").run({});
    expect(out).toContain("Deep Research engine");
    expect(out).toContain("Diesel spike hits the Southeast");
    expect(out).toContain("Counter-move: Fuel in Georgia before crossing into Florida.");
    expect(out).not.toContain("Diesel up 15 cents");
  });

  it("list_industry_briefings labels the industry-intelligence engine, not Deep Research content", async () => {
    const { client } = fakeClient(baseSeed());
    const out = await tool(store(client), "list_industry_briefings").run({});
    expect(out).toContain("industry-intelligence engine");
    expect(out).toContain("Diesel up 15 cents");
    expect(out).not.toContain("Diesel spike hits the Southeast");
  });

  it("get_research_briefing drills into findings, what changed, and the unverified flag", async () => {
    const { client } = fakeClient(baseSeed());
    const out = await tool(store(client), "get_research_briefing").run({ id: BRIEFING_ID });
    expect(out).toContain("PADD 1 diesel rose 9 cents WoW");
    expect(out).toContain("What changed: Regional spread widened");
    expect(out).toContain("Flagged unverified by the engine");
    const missing = await tool(store(client), "get_research_briefing").run({
      id: "99999999-9999-4999-8999-999999999999",
    });
    expect(missing).toContain("No Deep Research briefing with id");
  });

  it("both list tools say so plainly when their engine has nothing", async () => {
    const seed = baseSeed();
    seed.research_briefings = [];
    seed.industry_briefings = [];
    const { client } = fakeClient(seed);
    const s = store(client);
    expect(await tool(s, "list_research_briefings").run({})).toContain(
      "From the Deep Research engine: no briefings on file yet.",
    );
    expect(await tool(s, "list_industry_briefings").run({})).toContain(
      "From the industry-intelligence engine: no briefings on file yet.",
    );
  });
});

describe("queue_research", () => {
  it("inserts exactly the app route's manual row shape", async () => {
    const { client, db } = fakeClient(baseSeed());
    const out = await tool(store(client), "queue_research").run({
      topic: "Georgia weight-station enforcement changes",
    });
    expect(out).toContain("Queued a Deep Research run");
    expect(db.research_runs).toHaveLength(1);
    const row = db.research_runs![0]!;
    expect(row.company_id).toBe(COMPANY);
    expect(row.trigger_kind).toBe("manual");
    expect(row.status).toBe("queued");
    expect(row.topic).toBe("Georgia weight-station enforcement changes");
    expect(row.trigger_detail).toEqual({
      reason: "Owner requested this research in conversation with Abel.",
    });
  });

  it("rejects a topic under the app route's minimum length", async () => {
    const { client } = fakeClient(baseSeed());
    const t = tool(store(client), "queue_research");
    expect(t.validateArgs?.({ topic: "ab" })).toMatchObject({ ok: false });
    expect(t.validateArgs?.({ topic: "diesel prices in the Southeast" })).toMatchObject({ ok: true });
  });
});

describe("research_requests from conversation", () => {
  it("request_pretrip_photos queues an ask; list + dismiss round-trip it", async () => {
    const { client, db } = fakeClient(baseSeed());
    const s = store(client);
    const created = await tool(s, "request_pretrip_photos").run({
      load_id: LOAD_ID,
      reason: "Storm damage reported on this lane.",
    });
    expect(created).toContain("Recorded the pre-trip photo ask");
    expect(db.research_requests).toHaveLength(1);
    expect(db.research_requests![0]!.kind).toBe("pretrip_photo");
    expect(db.research_requests![0]!.status).toBe("queued");

    const listed = await tool(s, "list_research_requests").run({});
    expect(listed).toContain("tires, lights, load securement, BOL");
    expect(listed).toContain("Storm damage reported on this lane.");

    const id = String(db.research_requests![0]!.id);
    const dismissed = await tool(s, "dismiss_research_request").run({ request_id: id });
    expect(dismissed).toContain("Dismissed photo ask");
    expect(db.research_requests![0]!.status).toBe("dismissed");
    expect(await tool(s, "list_research_requests").run({})).toContain(
      "No pre-trip photo asks are waiting",
    );
  });
});

describe("the turn hook - pending asks surface in context", () => {
  it("adds the ask block with the load's lane when a request is queued", async () => {
    const seed = baseSeed();
    seed.research_requests = [
      {
        id: REQUEST_ID,
        company_id: COMPANY,
        load_id: LOAD_ID,
        kind: "pretrip_photo",
        detail: {
          checklist_kind: "pre-trip",
          items: ["tires", "lights", "load securement", "BOL"],
          reason: "Storm damage reported on this lane.",
        },
        status: "queued",
        created_at: "2026-11-02T08:00:00.000Z",
        fulfilled_at: null,
      },
    ];
    const { client } = fakeClient(seed);
    const seen: string[] = [];
    const provider: AgentCapableProvider = {
      complete: async () => {
        throw new Error("complete() is not used by the agent turn");
      },
      runToolTurn: vi.fn(async (messages) => {
        seen.push(JSON.stringify(messages));
        return { text: "Morning - ready when you are.", toolCalls: [] };
      }),
    };
    const input: BotChatInput = {
      userText: "Morning",
      history: [],
      snapshotText: null,
      instructions: [],
      memories: [],
    };
    const out = await runAgentTurn(provider, store(client), input);
    expect(out.reply).toContain("Morning");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("OUTSTANDING PRE-TRIP PHOTO ASKS");
    expect(seen[0]).toContain("Melbourne, FL → Atlanta, GA");
    expect(seen[0]).toContain("Storm damage reported on this lane.");
    expect(seen[0]).toContain("dismiss_research_request");
  });

  it("no queued asks, no block - the turn is unchanged", async () => {
    const { client } = fakeClient(baseSeed());
    const seen: string[] = [];
    const provider: AgentCapableProvider = {
      complete: async () => {
        throw new Error("complete() is not used by the agent turn");
      },
      runToolTurn: vi.fn(async (messages) => {
        seen.push(JSON.stringify(messages));
        return { text: "Morning.", toolCalls: [] };
      }),
    };
    const input: BotChatInput = {
      userText: "Morning",
      history: [],
      snapshotText: null,
      instructions: [],
      memories: [],
    };
    await runAgentTurn(provider, store(client), input);
    expect(seen[0]).not.toContain("OUTSTANDING PRE-TRIP PHOTO ASKS");
  });
});
