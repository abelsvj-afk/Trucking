// Autonomous Research bot tools (docs/design/autonomous-research.md
// §§3-5) against an in-memory fake Supabase client:
// - list_watch_topics names the five standing topics with freshness;
// - get_knowledge returns source + date + freshness, and SAYS the
//   picture is thin when nothing is stored;
// - the agenda flow keeps propose→yes discipline: the tick's
//   proposed rows wait until approve_learning_topic queues a manual
//   research run (the same row shape queue_research writes), and
//   dismiss_learning_topic closes a proposal without queueing;
// - propose_learning_topic (Abel-originated, staged by the write
//   gate) queues its run and records the agenda row in one motion.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildResearchAgendaTools } from "@/services/bot/research-agenda-tools";
import type { BotBrainStore } from "@/services/bot/store";
import type { AgentTool } from "@/services/ai/agent-loop";

const COMPANY = "company-1";
const TOPIC_ID = "47474747-4747-4474-8474-474747474747";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "in"; col: string; val: unknown };

class FakeQuery {
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(
    private readonly tables: Map<string, Row[]>,
    private readonly table: string,
  ) {}

  select(): this {
    return this;
  }
  insert(payload: Row): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row): this {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ op: "eq", col, val });
    return this;
  }
  in(col: string, val: unknown[]): this {
    this.filters.push({ op: "in", col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private rows(): Row[] {
    return this.tables.get(this.table) ?? [];
  }
  private matches(row: Row): boolean {
    return this.filters.every((f) =>
      f.op === "eq" ? row[f.col] === f.val : (f.val as unknown[]).includes(row[f.col]),
    );
  }
  private execute(): Row[] {
    if (this.op === "insert") {
      const row: Row = { id: `row-${this.rows().length + 1}`, ...this.payload };
      this.tables.set(this.table, [...this.rows(), row]);
      return [row];
    }
    if (this.op === "update") {
      const updated: Row[] = [];
      const next = this.rows().map((row) => {
        if (!this.matches(row)) return row;
        const merged = { ...row, ...this.payload };
        updated.push(merged);
        return merged;
      });
      this.tables.set(this.table, next);
      return updated;
    }
    let out = this.rows().filter((r) => this.matches(r));
    if (this.orderCol) {
      const col = this.orderCol;
      out = [...out].sort((a, b) =>
        this.orderAsc
          ? String(a[col]) < String(b[col])
            ? -1
            : 1
          : String(a[col]) > String(b[col])
            ? -1
            : 1,
      );
    }
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    return out;
  }
  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const rows = this.execute();
    return rows[0]
      ? { data: rows[0], error: null }
      : { data: null, error: { message: "no rows" } };
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.execute();
    return { data: rows[0] ?? null, error: null };
  }
  then<TResult>(resolve: (v: { data: Row[]; error: null }) => TResult): Promise<TResult> {
    return Promise.resolve(resolve({ data: this.execute(), error: null }));
  }
}

function fakeClient(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(Object.entries(seed));
  const client = {
    from: (table: string) => new FakeQuery(tables, table),
  } as unknown as SupabaseClient;
  return { client, tables };
}

function tools(client: SupabaseClient): Map<string, AgentTool> {
  const store = { client, companyId: COMPANY } as unknown as BotBrainStore;
  return new Map(buildResearchAgendaTools(store).map((t) => [t.name, t]));
}

const KNOWLEDGE_ROW: Row = {
  watch_topic: "crypto",
  title: "Crypto snapshot (2026-11-09)",
  content: "BTC $81,235 (down 2.3% in 24h), XRP $2.41 (up 1.1% in 24h). Awareness only.",
  source_title: "BTC price - 2026-11-09",
  source_url: "https://www.coingecko.com/",
  observed_at: new Date().toISOString(),
};

const PROPOSED_ROW: Row = {
  id: TOPIC_ID,
  company_id: COMPANY,
  topic: "Current costs and steps to get his own truck and MC authority",
  reason: "Nothing stored on the authority path yet.",
  watch_topic: "authority_pathways",
  proposed_by: "abel",
  status: "proposed",
  research_run_id: null,
  created_at: new Date().toISOString(),
  decided_at: null,
};

describe("list_watch_topics + get_knowledge", () => {
  it("names all five standing topics with a freshness read", async () => {
    const { client } = fakeClient({ research_knowledge: [{ ...KNOWLEDGE_ROW, company_id: COMPANY }] });
    const out = await tools(client).get("list_watch_topics")!.run({});
    for (const label of ["Your business", "trucking industry", "Crypto", "own truck", "build plan"]) {
      expect(out.toLowerCase()).toContain(label.toLowerCase());
    }
    expect(out).toContain("current");
    expect(out).toContain("nothing stored yet");
  });

  it("returns knowledge with source, date, and freshness", async () => {
    const { client } = fakeClient({ research_knowledge: [{ ...KNOWLEDGE_ROW, company_id: COMPANY }] });
    const out = await tools(client).get("get_knowledge")!.run({ topic: "crypto" });
    expect(out).toContain("BTC $81,235");
    expect(out).toContain("coingecko.com");
    expect(out).toContain("current");
  });

  it("says the picture is thin instead of guessing when nothing is stored", async () => {
    const { client } = fakeClient({ research_knowledge: [] });
    const out = await tools(client).get("get_knowledge")!.run({ topic: "authority_pathways" });
    expect(out).toContain("THIN");
  });
});

describe("learning agenda decisions", () => {
  it("lists proposed topics with their reasons", async () => {
    const { client } = fakeClient({ research_learning_topics: [PROPOSED_ROW] });
    const out = await tools(client).get("list_learning_topics")!.run({});
    expect(out).toContain("MC authority");
    expect(out).toContain("Nothing stored on the authority path yet.");
  });

  it("approve queues a manual research run and marks the topic queued", async () => {
    const { client, tables } = fakeClient({ research_learning_topics: [PROPOSED_ROW] });
    const out = await tools(client).get("approve_learning_topic")!.run({ id: TOPIC_ID });
    expect(out).toContain("Approved and queued");
    const runs = tables.get("research_runs") ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger_kind: "manual", status: "queued", company_id: COMPANY });
    expect((runs[0]!.trigger_detail as Row).learning_topic_id).toBe(TOPIC_ID);
    const topic = (tables.get("research_learning_topics") ?? [])[0];
    expect(topic!.status).toBe("queued");
    expect(topic!.research_run_id).toBe(runs[0]!.id);
  });

  it("dismiss closes the proposal and queues nothing", async () => {
    const { client, tables } = fakeClient({ research_learning_topics: [PROPOSED_ROW] });
    const out = await tools(client).get("dismiss_learning_topic")!.run({ id: TOPIC_ID });
    expect(out).toContain("Dismissed");
    expect(tables.get("research_runs") ?? []).toHaveLength(0);
    expect((tables.get("research_learning_topics") ?? [])[0]!.status).toBe("dismissed");
  });

  it("propose_learning_topic records the agenda row and queues its run", async () => {
    const { client, tables } = fakeClient({});
    const out = await tools(client).get("propose_learning_topic")!.run({
      topic: "Factoring costs for a brand-new authority",
      reason: "He asked about factoring and Abel had nothing stored.",
      watch_topic: "authority_pathways",
    });
    expect(out).toContain("Approved and queued");
    const topics = tables.get("research_learning_topics") ?? [];
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ status: "queued", proposed_by: "abel", company_id: COMPANY });
    expect(tables.get("research_runs") ?? []).toHaveLength(1);
  });
});
