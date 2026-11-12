// Lane 2, Phase A acceptance (Intelligence Upgrade design §7):
// (1) a unique fact at position #1 of 250 is retrieved - the
// newest-100 cliff is dead; (2) paraphrase + (3) Spanish/English
// crossover come back through the hybrid (RPC) arm even with zero
// keyword overlap; (4) truncation self-reports ("X of Y").

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fuseRrf,
  loadAllInstructions,
  retrieveCurrentFacts,
  searchMemoryEverywhere,
} from "@/services/bot/memory-retrieval";

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
      case "in":
        return Array.isArray(f.val) && f.val.includes(value);
      case "ilike": {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        return typeof value === "string" && value.toLowerCase().includes(needle);
      }
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
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ op: "gte", col, val }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ op: "lt", col, val }); return this; }
  in(col: string, val: unknown) { this.filters.push({ op: "in", col, val }); return this; }
  ilike(col: string, val: unknown) { this.filters.push({ op: "ilike", col, val }); return this; }
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

function fakeClient(db: Record<string, Row[]>, rpcImpl?: (fn: string, args: Row) => unknown) {
  return {
    from: (table: string) => new FakeQuery(db, table),
    rpc: vi.fn(async (fn: string, args: Row) => {
      if (!rpcImpl) return { data: null, error: { message: "function does not exist" } };
      return rpcImpl(fn, args);
    }),
  } as unknown as SupabaseClient;
}

const COMPANY = "company-1";
const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

describe("fuseRrf", () => {
  it("ranks an id present in both lists above ids in only one", () => {
    const fused = fuseRrf([
      ["a", "b", "c"],
      ["b", "d"],
    ]);
    expect(fused[0]?.id).toBe("b");
    expect(fused.map((f) => f.id)).toContain("d");
  });
});

describe("retrieveCurrentFacts - the 100-row cliff is dead", () => {
  it("acceptance A1: the OLDEST of 250 facts is retrieved by its unique words (fallback arm)", async () => {
    const rows: Row[] = [
      {
        id: "oldest",
        company_id: COMPANY,
        kind: "fact",
        content: "The quixotic zebra blanket stays in the cab",
        created_at: stamp(0),
        deleted_at: null,
        valid_to: null,
      },
    ];
    for (let i = 1; i < 250; i += 1) {
      rows.push({
        id: `fact-${i}`,
        company_id: COMPANY,
        kind: "fact",
        content: `Routine note number ${i} about driving and parking`,
        created_at: stamp(i),
        deleted_at: null,
        valid_to: null,
      });
    }
    const client = fakeClient({ bot_memories: rows });
    const result = await retrieveCurrentFacts(client, COMPANY, "zebra blanket");
    expect(result.totalFacts).toBe(250);
    expect(result.facts[0]?.id).toBe("oldest");
    // Acceptance A4: the truncation self-reports with real numbers.
    expect(result.truncated).toBe(true);
    expect(result.reportLine).toContain("of 250 current facts");
  });

  it("acceptance A2/A3: paraphrase and Spanish crossover return via the hybrid RPC arm with zero keyword overlap", async () => {
    const spanishFact = {
      id: "es-fact",
      kind: "fact",
      content: "Steven paga el combustible con su tarjeta",
      created_at: stamp(5),
    };
    const client = fakeClient({ bot_memories: [] }, (fn) => {
      if (fn === "abel_search_memories") return { data: [spanishFact], error: null };
      return { data: [], error: null };
    });
    const result = await retrieveCurrentFacts(client, COMPANY, "who covers diesel?");
    expect(result.facts.map((f) => f.id)).toContain("es-fact");
  });

  it("respects the fact limit and token budget, and says so", async () => {
    const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({
      id: `rpc-${i}`,
      kind: "fact",
      content: `Fact ${i} ` + "word ".repeat(60),
      created_at: stamp(i),
    }));
    const client = fakeClient({ bot_memories: [] }, () => ({ data: rows, error: null }));
    const result = await retrieveCurrentFacts(client, COMPANY, "anything", { tokenBudget: 300 });
    expect(result.facts.length).toBeLessThanOrEqual(12);
    expect(result.facts.length).toBeGreaterThan(0);
    const totalTokens = result.facts.reduce((sum, f) => sum + Math.ceil(f.content.length / 4), 0);
    expect(totalTokens).toBeLessThanOrEqual(300 + Math.ceil(result.facts[0]!.content.length / 4));
  });
});

describe("CD-3: fallback mode discloses itself honestly", () => {
  it("beyond 1,000 facts: the report names compatibility mode, the scanned window, and the unreachable rest", async () => {
    const rows: Row[] = [
      {
        id: "ancient",
        company_id: COMPANY,
        kind: "fact",
        content: "The quixotic zebra blanket stays in the cab",
        created_at: stamp(0),
        deleted_at: null,
        valid_to: null,
      },
    ];
    for (let i = 1; i <= 1005; i += 1) {
      rows.push({
        id: `fact-${i}`,
        company_id: COMPANY,
        kind: "fact",
        content: `Routine note number ${i} about driving and parking`,
        created_at: stamp(i),
        deleted_at: null,
        valid_to: null,
      });
    }
    const client = fakeClient({ bot_memories: rows });
    const result = await retrieveCurrentFacts(client, COMPANY, "zebra blanket");
    expect(result.mode).toBe("fallback");
    expect(result.totalFacts).toBe(1006);
    // The scan window is the newest 1,000 - the ancient fact is outside it.
    expect(result.scannedFacts).toBe(1000);
    expect(result.facts.map((f) => f.id)).not.toContain("ancient");
    // The line tells the truth: mode disclosed, window named, and NO
    // claim that the unscanned rest stay searchable (they don't -
    // search_memory's fallback arm scans the same window).
    expect(result.reportLine).toContain("compatibility mode");
    expect(result.reportLine).toContain("1000");
    expect(result.reportLine).toContain("1006");
    expect(result.reportLine).toContain("not reachable");
    expect(result.reportLine).not.toContain("the rest stay searchable");
  });

  it("fallback under the window still discloses the mode when the budget cuts", async () => {
    const rows: Row[] = Array.from({ length: 250 }, (_, i) => ({
      id: `fact-${i}`,
      company_id: COMPANY,
      kind: "fact",
      content: `Routine note number ${i} about driving and parking`,
      created_at: stamp(i),
      deleted_at: null,
      valid_to: null,
    }));
    const client = fakeClient({ bot_memories: rows });
    const result = await retrieveCurrentFacts(client, COMPANY, "driving");
    expect(result.mode).toBe("fallback");
    expect(result.scannedFacts).toBe(250);
    expect(result.reportLine).toContain("compatibility mode");
    expect(result.reportLine).toContain("of 250 current facts");
  });

  it("hybrid mode keeps its original wording (and its search_memory promise is true there)", async () => {
    const dbRows: Row[] = Array.from({ length: 20 }, (_, i) => ({
      id: `db-${i}`,
      company_id: COMPANY,
      kind: "fact",
      content: `Stored fact ${i}`,
      created_at: stamp(i),
      deleted_at: null,
      valid_to: null,
    }));
    const rpcRows = Array.from({ length: 24 }, (_, i) => ({
      id: `rpc-${i}`,
      kind: "fact",
      content: `Fact ${i}`,
      created_at: stamp(i),
    }));
    const client = fakeClient({ bot_memories: dbRows }, (fn) =>
      fn === "abel_search_memories" ? { data: rpcRows, error: null } : { data: [], error: null },
    );
    const result = await retrieveCurrentFacts(client, COMPANY, "anything");
    expect(result.mode).toBe("hybrid");
    expect(result.scannedFacts).toBe(20);
    expect(result.reportLine).toContain("the rest stay searchable via search_memory");
    expect(result.reportLine).not.toContain("compatibility mode");
  });
});

describe("loadAllInstructions", () => {
  it("returns EVERY instruction, even ones older than 100 newer memories", async () => {
    const rows: Row[] = [
      { id: "inst-old", company_id: COMPANY, kind: "instruction", content: "Always text Steven before a pickup", created_at: stamp(0), deleted_at: null, valid_to: null },
      { id: "inst-new", company_id: COMPANY, kind: "instruction", content: "Never book below $2 a mile", created_at: stamp(500), deleted_at: null, valid_to: null },
    ];
    for (let i = 1; i < 150; i += 1) {
      rows.push({ id: `f-${i}`, company_id: COMPANY, kind: "fact", content: `note ${i}`, created_at: stamp(i), deleted_at: null, valid_to: null });
    }
    const client = fakeClient({ bot_memories: rows });
    const instructions = await loadAllInstructions(client, COMPANY);
    expect(instructions.map((m) => m.id).sort()).toEqual(["inst-new", "inst-old"]);
  });
});

describe("searchMemoryEverywhere (fallback arms)", () => {
  it("finds hits in memories, past messages, and documents in one call", async () => {
    const db: Record<string, Row[]> = {
      bot_memories: [
        { id: "m1", company_id: COMPANY, kind: "fact", content: "Detention pays after two hours", created_at: stamp(1), deleted_at: null, valid_to: null },
      ],
      telegram_messages: [
        { id: "t1", company_id: COMPANY, role: "user", text: "Broker said detention is on them", created_at: stamp(2), deleted_at: null },
      ],
      documents: [
        { id: "d1", company_id: COMPANY, file_name: "rate-con.pdf", extracted_text: "Detention: $50/hr after 2 hours", created_at: stamp(3) },
      ],
    };
    const client = fakeClient(db);
    const hits = await searchMemoryEverywhere(client, COMPANY, "detention");
    const sources = new Set(hits.map((h) => h.source));
    expect(sources).toEqual(new Set(["memory", "message", "document"]));
  });
});

describe("retrieveCurrentFacts — Frontier 2 half-life re-rank (F2-C, retrieval path)", () => {
  it("a 30-day-old note ranks below a fresh fact of equal RRF similarity", async () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const db: Record<string, Row[]> = {
      bot_memories: [
        {
          id: "old-note", company_id: COMPANY, kind: "note",
          content: "Detention pays after two hours at the Macon yard",
          created_at: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
          deleted_at: null, valid_to: null,
        },
        {
          id: "fresh-fact", company_id: COMPANY, kind: "fact",
          content: "Detention pays after two hours at the Macon yard",
          created_at: now.toISOString(),
          deleted_at: null, valid_to: null,
        },
      ],
    };
    // Equal hybrid scores from the RPC — the half-life decides.
    const client = fakeClient(db, () => ({
      data: [
        { id: "old-note", kind: "note", content: "Detention pays after two hours at the Macon yard", created_at: new Date(now.getTime() - 30 * 86_400_000).toISOString(), rrf_score: 0.5 },
        { id: "fresh-fact", kind: "fact", content: "Detention pays after two hours at the Macon yard", created_at: now.toISOString(), rrf_score: 0.5 },
      ],
      error: null,
    }));
    const result = await retrieveCurrentFacts(client, COMPANY, "detention Macon yard");
    expect(result.mode).toBe("hybrid");
    expect(result.facts.map((f) => f.id)).toEqual(["fresh-fact", "old-note"]);
  });

  it("a constraint (standing instruction kind) never decays out of relevance", async () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const db: Record<string, Row[]> = {
      bot_memories: [
        {
          id: "old-instruction", company_id: COMPANY, kind: "instruction",
          content: "Always text before calling about detention pay",
          created_at: new Date(now.getTime() - 300 * 86_400_000).toISOString(),
          deleted_at: null, valid_to: null,
        },
        {
          id: "fresh-note", company_id: COMPANY, kind: "note",
          content: "Detention pay question at the yard",
          created_at: now.toISOString(),
          deleted_at: null, valid_to: null,
        },
      ],
    };
    const client = fakeClient(db, () => ({
      data: [
        { id: "old-instruction", kind: "instruction", content: "Always text before calling about detention pay", created_at: new Date(now.getTime() - 300 * 86_400_000).toISOString(), rrf_score: 0.4 },
        { id: "fresh-note", kind: "note", content: "Detention pay question at the yard", created_at: now.toISOString(), rrf_score: 0.4 },
      ],
      error: null,
    }));
    const result = await retrieveCurrentFacts(client, COMPANY, "detention pay");
    // Equal scores; the 300-day-old instruction is undecayed (0.4)
    // while the fresh note is also 0.4 — the tie keeps RPC order.
    expect(result.facts.map((f) => f.id)).toEqual(["old-instruction", "fresh-note"]);
  });
});
