// Frontier 2-D — a learned lesson synthesized in a consolidation
// run is visible through the app-page data function with its
// evidence, and correcting it writes a superseding stated row at
// max confidence. Plus the synthesis guard at run level: an
// already-known lesson is dropped, never staged twice.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runConsolidation } from "@/services/bot/consolidation";
import { correctEpisode, saveEpisode } from "@/services/bot/episodes";
import { loadWhatIKnowModel } from "@/services/bot/what-i-know";

type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    switch (f.op) {
      case "eq": return value === f.val;
      case "is": return f.val === null ? value === null || value === undefined : value === f.val;
      case "gte": return typeof value === "string" && typeof f.val === "string" ? value >= f.val : Number(value) >= Number(f.val);
      case "lt": return typeof value === "string" && typeof f.val === "string" ? value < f.val : Number(value) < Number(f.val);
      default: return true;
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

  constructor(private db: Record<string, Row[]>, private table: string) {}

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
const NOW = new Date("2026-11-11T08:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function outcomeRow(signature: string, outcome: string, days: number): Row {
  return { id: `o-${signature}-${outcome}-${days}`, company_id: COMPANY, tool_name: signature.split("/")[0]!, signature, outcome, summary: "s", created_at: daysAgo(days) };
}

function seedDb(): Record<string, Row[]> {
  return {
    telegram_messages: [],
    bot_memories: [],
    agent_episodes: [],
    bot_pending_actions: [],
    conversation_summaries: [],
    consolidation_runs: [],
    bot_proposal_outcomes: [
      outcomeRow("digest/morning", "dropped", 1),
      outcomeRow("digest/morning", "dropped", 2),
      outcomeRow("digest/morning", "dropped", 3),
      outcomeRow("digest/morning", "dropped", 4),
      outcomeRow("digest/morning", "approved", 5),
    ],
  };
}

function deps(db: Record<string, Row[]>) {
  const client = { from: (table: string) => new FakeQuery(db, table) } as unknown as SupabaseClient;
  return {
    client,
    companyId: COMPANY,
    isEnabled: async () => true,
    summarize: async () => "A quiet week.",
    extractCandidates: async () => [] as string[],
    embedder: null,
    now: NOW,
  };
}

describe("consolidation lesson synthesis (F2-D)", () => {
  it("stages a learned lesson from his answer pattern — never saves it directly — with its evidence", async () => {
    const db = seedDb();
    const result = await runConsolidation(deps(db));
    expect(result.ran).toBe(true);
    expect(result.lessonsStaged).toBe(1);
    expect(db.bot_memories!).toHaveLength(0);
    expect(db.agent_episodes!).toHaveLength(0);
    const staged = db.bot_pending_actions!.filter((r) => r.tool_name === "save_agent_lesson");
    expect(staged).toHaveLength(1);
    const args = staged[0]!.arguments as Row;
    expect(args.kind).toBe("learned");
    expect(String(args.lesson)).toContain("digest (morning)");
    expect(String(args.lesson)).toContain("(pattern: digest/morning)");
    // The evidence travels with the staged proposal.
    expect(String(args.situation)).toContain("approved 1, turned down 4");
  });

  it("drops a lesson that is already kept (duplicate band), never stages it twice", async () => {
    const db = seedDb();
    db.agent_episodes!.push({
      id: "ep-keep", company_id: COMPANY, kind: "learned",
      summary: "Learned: digest (morning) suggestions",
      situation: "Based on his answers (last 90 days).",
      lesson: "Lesson learned from his answers: he usually turns down digest (morning) suggestions (4 of 5) - only suggest them when he asks for one. (pattern: digest/morning)",
      valence: "hurt", confidence: 0.8, created_at: daysAgo(1), valid_to: null, deleted_at: null,
    });
    const result = await runConsolidation(deps(db));
    expect(result.lessonsStaged).toBe(0);
    expect(result.lessonsDropped).toBe(1);
    expect(db.bot_pending_actions!.filter((r) => r.tool_name === "save_agent_lesson")).toHaveLength(0);
  });

  it("a staged lesson, once approved, is visible in the model with its evidence — and correcting it writes a superseding stated row at confidence 1.0", async () => {
    const db = seedDb();
    await runConsolidation(deps(db));
    const staged = db.bot_pending_actions!.find((r) => r.tool_name === "save_agent_lesson")!;
    const args = staged.arguments as Row;
    // Simulate his yes: the save_agent_lesson tool executes.
    const savedId = await saveEpisode(deps(db).client, COMPANY, {
      kind: "learned",
      summary: String(args.summary),
      situation: String(args.situation),
      lesson: String(args.lesson),
      valence: "hurt",
      confidence: 0.8,
      provenance: "model_inferred_unconfirmed",
    });
    expect(savedId).toBeTruthy();
    const model = await loadWhatIKnowModel(deps(db).client, COMPANY);
    expect(model.lessons).toHaveLength(1);
    expect(model.lessons[0]!.evidence).toContain("approved 1, turned down 4");
    // He corrects it: superseding row, owner_stated, confidence 1.0.
    const newId = await correctEpisode(deps(db).client, COMPANY, savedId!, "Only suggest a morning digest on Mondays, when he asks.");
    const corrected = db.agent_episodes!.find((r) => r.id === newId)!;
    expect(corrected.provenance).toBe("owner_stated");
    expect(Number(corrected.confidence)).toBe(1);
    expect(db.agent_episodes!.find((r) => r.id === savedId)!.valid_to).not.toBeNull();
    const modelAfter = await loadWhatIKnowModel(deps(db).client, COMPANY);
    expect(modelAfter.lessons).toHaveLength(1);
    expect(modelAfter.lessons[0]!.lesson).toContain("Mondays");
  });
});
