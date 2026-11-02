// Lane 2, Phase A acceptance (design §7 #4/#5 + §3.5): context
// assembly v2 - instructions in full regardless of age, facts via
// retrieval with the self-report line attached, history windowed
// at 12 verbatim turns, and the weekly summary riding along for
// anything older.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore } from "@/services/bot/store";
import { loadBotContext } from "@/services/bot/agent-turn";
import { weekStartOf } from "@/services/bot/summaries";

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
      case "in":
        return Array.isArray(f.val) && f.val.includes(value);
      default:
        return true;
    }
  });
}

class FakeQuery {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private countHead = false;

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.countHead = true;
    return this;
  }
  insert(payload: Row) { void payload; return this; }
  update(payload: Row) { void payload; return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ op: "gte", col, val }); return this; }
  in(col: string, val: unknown) { this.filters.push({ op: "in", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private execute() {
    const rows = (this.db[this.table] ??= []);
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
    return { data: matched, error: null, count: matched.length };
  }
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: ReturnType<FakeQuery["execute"]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

const COMPANY = "company-1";
const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

describe("loadBotContext (assembly v2)", () => {
  it("instructions in full, facts retrieved with a self-report, summary attached, history = 12", async () => {
    const memories: Row[] = [
      { id: "inst-1", company_id: COMPANY, kind: "instruction", content: "Always confirm the gate code", created_at: stamp(0), deleted_at: null, valid_to: null },
    ];
    for (let i = 1; i <= 130; i += 1) {
      memories.push({
        id: `f-${i}`,
        company_id: COMPANY,
        kind: "fact",
        content: i === 77 ? "The Macon yard gate code is 4417" : `filler note ${i}`,
        created_at: stamp(i),
        deleted_at: null,
        valid_to: null,
      });
    }
    const messages: Row[] = Array.from({ length: 30 }, (_, i) => ({
      id: `m-${i}`,
      company_id: COMPANY,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `turn ${i}`,
      created_at: stamp(1000 + i),
      deleted_at: null,
    }));
    // Snapshot source tables the store reads - all empty is fine.
    const db: Record<string, Row[]> = {
      bot_memories: memories,
      telegram_messages: messages,
      loads: [],
      duty_logs: [],
      expenses: [],
      fuel_purchases: [],
      brokers: [],
      customers: [],
      drivers: [],
      conversation_summaries: [
        { id: "s1", company_id: COMPANY, week_start: "2026-10-26", summary: "Last week he started the Macon lane.", created_at: stamp(5), updated_at: stamp(6), deleted_at: null },
      ],
    };
    const client = {
      from: (table: string) => new FakeQuery(db, table),
      rpc: async () => ({ data: null, error: { message: "no rpc in fake" } }),
    } as unknown as SupabaseClient;
    const store = createBotStore(client, COMPANY, "web");

    const ctx = await loadBotContext(store, "what is the Macon gate code?");

    // The old instruction survived 130 newer memories (acceptance: no regression, instructions in full).
    expect(ctx.instructions.map((m) => m.content)).toEqual(["Always confirm the gate code"]);
    // The relevant fact was retrieved from beyond the old 100-window.
    expect(ctx.memories.some((m) => m.content.includes("4417"))).toBe(true);
    // Self-report present with the true total.
    expect(ctx.memoryReport).toContain("of 131 current facts");
    // 12 verbatim turns, newest last.
    expect(ctx.history).toHaveLength(12);
    expect(ctx.history[ctx.history.length - 1]?.text).toBe("turn 29");
    // The rolling summary rides along.
    expect(ctx.summaryText).toContain("Macon lane");
  });
});

describe("weekStartOf", () => {
  it("Monday stays, Sunday belongs to the previous Monday", () => {
    expect(weekStartOf(new Date("2026-11-02T12:00:00.000Z"))).toBe("2026-11-02"); // Monday
    expect(weekStartOf(new Date("2026-11-01T12:00:00.000Z"))).toBe("2026-10-26"); // Sunday
    expect(weekStartOf(new Date("2026-11-04T12:00:00.000Z"))).toBe("2026-11-02"); // Wednesday
  });
});
