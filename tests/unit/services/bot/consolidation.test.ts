// Lane 2, Phase B acceptance (Intelligence Upgrade design §7):
// (3) a fact stated only in chat is STAGED as a proposal by the
// night shift - never saved directly; (2) a near-duplicate is
// offered as an update, not a second row; (4) kill switch off ->
// no consolidation writes at all.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runConsolidation } from "@/services/bot/consolidation";

type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

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
      case "lt":
        return typeof value === "string" && typeof f.val === "string" ? value < f.val : Number(value) < Number(f.val);
      default:
        return true;
    }
  });
}

class FakeQuery {
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
  ) {}

  select() { return this; }
  insert(payload: Row) { this.op = "insert"; this.payload = payload; return this; }
  update(payload: Row) { this.op = "update"; this.payload = payload; return this; }
  upsert(payload: Row) { this.op = "upsert"; this.payload = payload; return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ op: "gte", col, val }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ op: "lt", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private execute(single: boolean, maybe: boolean) {
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert") {
      const row: Row = { id: `ins-${rows.length + 1}`, created_at: new Date().toISOString(), ...this.payload };
      rows.push(row);
      return { data: single || maybe ? row : [row], error: null, count: null };
    }
    if (this.op === "upsert") {
      const key = `${this.payload?.company_id}:${this.payload?.week_start}`;
      const existing = rows.find((r) => `${r.company_id}:${r.week_start}` === key);
      if (existing) Object.assign(existing, this.payload);
      else rows.push({ id: `ups-${rows.length + 1}`, ...this.payload });
      return { data: null, error: null, count: null };
    }
    if (this.op === "update") {
      for (const row of rows) if (matches(row, this.filters)) Object.assign(row, this.payload);
      return { data: null, error: null, count: null };
    }
    let matched = rows.filter((row) => matches(row, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      matched = [...matched].sort((a, b) => {
        const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    if (single) return { data: matched[0] ?? null, error: matched[0] ? null : { message: "no rows" }, count: null };
    if (maybe) return { data: matched[0] ?? null, error: null, count: null };
    return { data: matched, error: null, count: matched.length };
  }
  single() { return Promise.resolve(this.execute(true, false)); }
  maybeSingle() { return Promise.resolve(this.execute(false, true)); }
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: ReturnType<FakeQuery["execute"]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.execute(false, false)).then(onfulfilled, onrejected);
  }
}

const COMPANY = "company-1";
const NOW = new Date("2026-11-02T08:00:00.000Z");

function seedDb(): Record<string, Row[]> {
  return {
    telegram_messages: [
      { id: "t1", company_id: COMPANY, role: "user", text: "Steven said detention pays after two hours at the Macon yard", created_at: "2026-11-01T20:00:00.000Z", deleted_at: null },
      { id: "t2", company_id: COMPANY, role: "assistant", text: "Noted.", created_at: "2026-11-01T20:01:00.000Z", deleted_at: null },
    ],
    bot_memories: [],
    bot_pending_actions: [],
    conversation_summaries: [],
    consolidation_runs: [],
  };
}

function deps(db: Record<string, Row[]>, overrides: Partial<Parameters<typeof runConsolidation>[0]> = {}) {
  const client = { from: (table: string) => new FakeQuery(db, table) } as unknown as SupabaseClient;
  return {
    client,
    companyId: COMPANY,
    isEnabled: async () => true,
    summarize: async () => "A quiet week.",
    extractCandidates: async () => ["Detention pays after two hours at the Macon yard"],
    embedder: null,
    now: NOW,
    ...overrides,
  };
}

describe("runConsolidation", () => {
  it("acceptance B4: kill switch off -> no writes of any kind", async () => {
    const db = seedDb();
    const result = await runConsolidation(deps(db, { isEnabled: async () => false }));
    expect(result.ran).toBe(false);
    expect(db.bot_pending_actions).toHaveLength(0);
    expect(db.consolidation_runs).toHaveLength(0);
    expect(db.conversation_summaries).toHaveLength(0);
    expect(db.bot_memories).toHaveLength(0);
  });

  it("acceptance B3: a chat-stated fact is STAGED as a proposal - never saved directly", async () => {
    const db = seedDb();
    const result = await runConsolidation(deps(db));
    expect(result.ran).toBe(true);
    expect(result.proposalsStaged).toBe(1);
    expect(db.bot_memories).toHaveLength(0); // nothing auto-promoted
    expect(db.bot_pending_actions).toHaveLength(1);
    const proposal = db.bot_pending_actions![0]!;
    expect(proposal.tool_name).toBe("save_memory");
    expect((proposal.arguments as Row).content).toContain("Detention pays after two hours");
    expect(result.report).toContain("staged 1 memory proposal");
    expect(db.consolidation_runs).toHaveLength(1);
  });

  it("acceptance B2: a near-duplicate candidate is staged as an UPDATE naming the old row", async () => {
    const db = seedDb();
    db.bot_memories = [
      { id: "old-1", company_id: COMPANY, kind: "fact", content: "Steven settles on Fridays", created_at: "2026-10-01T00:00:00.000Z", deleted_at: null, valid_to: null },
    ];
    const result = await runConsolidation(
      deps(db, { extractCandidates: async () => ["Steven settles on Thursdays"] }),
    );
    expect(result.updatesStaged).toBe(1);
    expect(result.proposalsStaged).toBe(0);
    const proposal = db.bot_pending_actions![0]!;
    expect((proposal.arguments as Row).supersedes_id).toBe("old-1");
    expect(String(proposal.summary)).toContain("Update a remembered fact");
    // The old row is untouched until the owner says yes.
    expect(db.bot_memories![0]?.valid_to).toBeNull();
  });

  it("an already-known candidate is dropped, not re-proposed", async () => {
    const db = seedDb();
    db.bot_memories = [
      { id: "old-1", company_id: COMPANY, kind: "fact", content: "Detention pays after two hours at the Macon yard", created_at: "2026-10-01T00:00:00.000Z", deleted_at: null, valid_to: null },
    ];
    const result = await runConsolidation(deps(db));
    expect(result.duplicatesDropped).toBe(1);
    expect(db.bot_pending_actions).toHaveLength(0);
  });

  it("refreshes the weekly summary from raw turns with their source ids", async () => {
    const db = seedDb();
    const summarize = vi.fn(async () => "He mentioned detention at Macon.");
    await runConsolidation(deps(db, { summarize, extractCandidates: async () => [] }));
    expect(summarize).toHaveBeenCalled();
    expect(db.conversation_summaries!.length).toBeGreaterThan(0);
    const summary = db.conversation_summaries![0]!;
    expect(summary.summary).toContain("detention at Macon");
    expect(summary.source_message_ids).toContain("t1");
  });
});
