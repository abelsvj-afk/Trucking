// Frontier 2 — pre-action recall tests. The recall block is
// built from seeded agent_episodes via the fake client (RPC
// unavailable, so the keyword fallback runs).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recallLessons } from "@/services/bot/lesson-recall";

const COMPANY = "company-1";
type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    switch (f.op) {
      case "eq": return value === f.val;
      case "is": return f.val === null ? value === null || value === undefined : value === f.val;
      default: return true;
    }
  });
}

class FakeQuery {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  constructor(private db: Record<string, Row[]>, private table: string) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitN = n; return this; }
  private execute() {
    let matched = (this.db[this.table] ?? []).filter((row) => matches(row, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      matched = [...matched].sort((a, b) => {
        const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    return { data: matched, error: null, count: matched.length };
  }
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: ReturnType<FakeQuery["execute"]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

const NOW = new Date("2026-11-11T12:00:00Z");

function seedDb(): Record<string, Row[]> {
  return {
    agent_episodes: [
      { id: "ep-hurt", company_id: COMPANY, kind: "learned", summary: "Morning digest flops", situation: "Suggested a morning digest 3 times; he dropped each one.", lesson: "Only suggest a morning digest when he asks for one.", valence: "hurt", confidence: 0.9, created_at: "2026-11-10T08:00:00.000Z", valid_to: null, deleted_at: null },
      { id: "ep-helped", company_id: COMPANY, kind: "learned", summary: "Fuel stop reminder helped", situation: "Reminded him about the cheap fuel stop before the long leg.", lesson: "Flag the cheap fuel stop before a long leg.", valence: "helped", confidence: 0.8, created_at: "2026-11-09T08:00:00.000Z", valid_to: null, deleted_at: null },
      { id: "ep-nolesson", company_id: COMPANY, kind: "acted", summary: "Did create_expense", situation: null, lesson: null, valence: "helped", confidence: 0.9, created_at: "2026-11-09T08:00:00.000Z", valid_to: null, deleted_at: null },
    ],
  };
}

function fakeClient(db: Record<string, Row[]>) {
  return {
    from: (table: string) => new FakeQuery(db, table),
    rpc: async () => ({ data: null, error: { message: "no rpc in fake" } }),
  } as unknown as SupabaseClient;
}

describe("recallLessons", () => {
  it("returns the WHAT I'VE LEARNED block, one line per lesson with its evidence", async () => {
    const recall = await recallLessons(fakeClient(seedDb()), COMPANY, "morning digest", null, { now: NOW });
    expect(recall.block).toContain("WHAT I'VE LEARNED ABOUT WORKING WITH HIM");
    expect(recall.block).toContain("Only suggest a morning digest when he asks for one.");
    expect(recall.block).toContain("Suggested a morning digest 3 times");
    expect(recall.lessons).toHaveLength(1);
  });

  it("puts a high-confidence hurt lesson first and exposes its confidence as the F5 annoyance term", async () => {
    const db = seedDb();
    // Both lessons match "fuel" loosely via the digest text? No —
    // use a situation matching both rows' shared words instead:
    // "morning" matches only the hurt one; add a helped lesson
    // about mornings with lower confidence.
    db.agent_episodes!.push({
      id: "ep-helped2", company_id: COMPANY, kind: "learned", summary: "Morning check-in helped",
      situation: "A short morning check-in kept the day on track.", lesson: "A short morning check-in helps.",
      valence: "helped", confidence: 0.6, created_at: "2026-11-10T09:00:00.000Z", valid_to: null, deleted_at: null,
    });
    const recall = await recallLessons(fakeClient(db), COMPANY, "morning", null, { now: NOW });
    expect(recall.lessons[0]!.id).toBe("ep-hurt");
    expect(recall.maxHurtConfidence).toBeCloseTo(0.9, 5);
  });

  it("maxHurtConfidence is 0 when no high-confidence hurt lesson is recalled", async () => {
    const recall = await recallLessons(fakeClient(seedDb()), COMPANY, "fuel stop", null, { now: NOW });
    expect(recall.lessons.map((l) => l.id)).toEqual(["ep-helped"]);
    expect(recall.maxHurtConfidence).toBe(0);
  });

  it("returns empty (never throws) for a blank situation or a failed read", async () => {
    const recall = await recallLessons(fakeClient(seedDb()), COMPANY, "   ", null, { now: NOW });
    expect(recall).toEqual({ lessons: [], block: null, maxHurtConfidence: 0, annoyance: 0 });
    const broken = { from: () => { throw new Error("db down"); }, rpc: async () => ({ data: null, error: { message: "no" } }) } as unknown as SupabaseClient;
    const recall2 = await recallLessons(broken, COMPANY, "morning digest", null, { now: NOW });
    expect(recall2.block).toBeNull();
  });

  it("includes the annoyance line when the candidate category's signal is > 0", async () => {
    const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
    const outcomeRows = [1, 2, 3].map((i) => ({
      tool_name: "digest", signature: "digest/morning", outcome: "dropped" as const,
      summary: "s", created_at: daysAgo(i),
    }));
    const recall = await recallLessons(fakeClient(seedDb()), COMPANY, "morning digest", null, {
      now: NOW, category: "digest/morning", outcomeRows,
    });
    expect(recall.annoyance).toBeGreaterThan(0);
    expect(recall.block).toContain("turning down digest/morning suggestions lately");
  });
});
