// Frontier 2 — agent_episodes store: save/list/search,
// supersession (close-not-delete), the supersession-chain reader,
// the hot-path acted + correction erred writers, and the
// consolidation-time learned-lesson synthesis guard (F1
// verification on synthesis: a lesson quoting a superseded figure
// is dropped, never staged).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyEpisodeSupersession,
  episodeSupersessionChain,
  listEpisodes,
  recordActedEpisode,
  recordErredEpisode,
  saveEpisode,
  searchEpisodes,
  synthesizeLearnedLessons,
} from "@/services/bot/episodes";

const COMPANY = "company-1";
const OTHER = "company-2";

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
      case "in":
        return Array.isArray(f.val) && f.val.includes(value);
      default:
        return true;
    }
  });
}

class FakeQuery {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
    private calls: { table: string; filters: Filter[]; op?: string; payload?: Row | null }[],
  ) {}

  select() { return this; }
  insert(payload: Row) { this.op = "insert"; this.payload = payload; return this; }
  update(payload: Row) { this.op = "update"; this.payload = payload; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  in(col: string, val: unknown) { this.filters.push({ op: "in", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private execute(single: boolean, maybe: boolean) {
    this.calls.push({ table: this.table, filters: [...this.filters], op: this.op, payload: this.payload });
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert") {
      const row: Row = { id: `ep-${rows.length + 1}`, created_at: new Date().toISOString(), valid_to: null, superseded_by: null, deleted_at: null, ...this.payload };
      rows.push(row);
      return { data: single || maybe ? row : [row], error: null, count: null };
    }
    if (this.op === "update") {
      for (const row of rows) if (matches(row, this.filters)) Object.assign(row, this.payload);
      return { data: null, error: null, count: null };
    }
    if (this.op === "delete") {
      const kept = rows.filter((row) => !matches(row, this.filters));
      this.db[this.table] = kept;
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

function fakeClient(db: Record<string, Row[]>, calls: { table: string; filters: Filter[]; op?: string; payload?: Row | null }[] = [], rpcImpl?: (fn: string) => { data: unknown; error: { message: string } | null }) {
  const client = {
    from: (table: string) => new FakeQuery(db, table, calls),
    rpc: async (fn: string) => (rpcImpl ? rpcImpl(fn) : { data: null, error: { message: `rpc ${fn} unavailable` } }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

function seedDb(): Record<string, Row[]> {
  return {
    agent_episodes: [
      { id: "ep-old", company_id: COMPANY, kind: "learned", summary: "Old lesson", situation: "Morning digests", lesson: "He turns down morning digests.", valence: "hurt", confidence: 0.8, created_at: "2026-10-01T08:00:00.000Z", valid_to: null, superseded_by: null, deleted_at: null },
      { id: "ep-other", company_id: OTHER, kind: "learned", summary: "Other company", situation: "", lesson: "Not his.", valence: "neutral", confidence: 0.5, created_at: "2026-10-01T08:00:00.000Z", valid_to: null, superseded_by: null, deleted_at: null },
    ],
    bot_memories: [],
    bot_proposal_outcomes: [],
  };
}

describe("saveEpisode / listEpisodes", () => {
  it("saves a learned episode and lists current episodes only", async () => {
    const db = seedDb();
    const { client } = fakeClient(db);
    const id = await saveEpisode(client, COMPANY, {
      kind: "learned",
      summary: "He turns down morning digests",
      situation: "Suggested a morning digest 3 times; dropped each time.",
      lesson: "Only suggest a morning digest when he asks for one.",
      valence: "hurt",
      confidence: 0.9,
      provenance: "model_inferred_unconfirmed",
    });
    expect(id).toBeTruthy();
    const current = await listEpisodes(client, COMPANY);
    expect(current.map((e) => e.id)).toContain(id);
    expect(current.map((e) => e.id)).not.toContain("ep-other");
  });

  it("every episode query is company-scoped (tenant suite surface)", async () => {
    const db = seedDb();
    const { client, calls } = fakeClient(db);
    await listEpisodes(client, COMPANY);
    await saveEpisode(client, COMPANY, { kind: "said", summary: "x" });
    await searchEpisodes(client, COMPANY, "digest");
    await listEpisodes(client, COMPANY, { includeHistory: true });
    const episodeCalls = calls.filter((c) => c.table === "agent_episodes");
    expect(episodeCalls.length).toBeGreaterThan(0);
    for (const call of episodeCalls) {
      // Reads/updates filter company_id; inserts carry it in the payload.
      if (call.op === "insert") {
        expect((call.payload as Row | null)?.company_id).toBe(COMPANY);
      } else {
        expect(call.filters).toContainEqual({ op: "eq", col: "company_id", val: COMPANY });
      }
    }
  });
});

describe("applyEpisodeSupersession + chain (F2-B, episodes side)", () => {
  it("a correction closes the old row and the chain returns old values with who superseded whom", async () => {
    const db = seedDb();
    const { client } = fakeClient(db);
    const newId = await saveEpisode(client, COMPANY, {
      kind: "learned",
      summary: "Corrected lesson",
      lesson: "He turns down morning digests except on Mondays.",
      valence: "hurt",
      confidence: 1,
      provenance: "owner_stated",
    });
    const closed = await applyEpisodeSupersession(client, COMPANY, { id: newId!, kind: "learned", summary: "Corrected lesson" }, { supersedesId: "ep-old" });
    expect(closed.map((r) => r.id)).toEqual(["ep-old"]);
    // "What's true now" returns only the new value.
    const current = await listEpisodes(client, COMPANY);
    expect(current.map((e) => e.id)).toContain(newId);
    expect(current.map((e) => e.id)).not.toContain("ep-old");
    // History keeps the old value with its chain.
    const chain = await episodeSupersessionChain(client, COMPANY, newId!);
    expect(chain.map((c) => c.id)).toEqual(["ep-old", newId]);
    expect(chain[0]!.superseded_by).toBe(newId);
    expect(chain[0]!.lesson).toBe("He turns down morning digests.");
    // The chain is also reachable from the old row.
    const chainFromOld = await episodeSupersessionChain(client, COMPANY, "ep-old");
    expect(chainFromOld.map((c) => c.id)).toEqual(["ep-old", newId]);
  });

  it("an explicit supersedesId always closes, even without a subject match", async () => {
    const db = seedDb();
    const { client } = fakeClient(db);
    const closed = await applyEpisodeSupersession(client, COMPANY, { id: "ep-new", kind: "said", summary: "x" }, { supersedesId: "ep-old" });
    expect(closed).toHaveLength(1);
    expect(db.agent_episodes!.find((r) => r.id === "ep-old")!.valid_to).not.toBeNull();
  });
});

describe("searchEpisodes", () => {
  it("falls back to a keyword scan when the RPC is unavailable, and ranks fresh above old at equal match", async () => {
    const db: Record<string, Row[]> = {
      agent_episodes: [
        { id: "ep-fresh", company_id: COMPANY, kind: "learned", summary: "morning digest lesson", lesson: "morning digest turned down", created_at: "2026-11-11T08:00:00.000Z", valid_to: null, deleted_at: null },
        { id: "ep-stale", company_id: COMPANY, kind: "learned", summary: "morning digest lesson", lesson: "morning digest turned down", created_at: "2026-10-12T08:00:00.000Z", valid_to: null, deleted_at: null },
      ],
    };
    const { client } = fakeClient(db);
    const hits = await searchEpisodes(client, COMPANY, "morning digest", { now: new Date("2026-11-11T12:00:00Z") });
    expect(hits.map((h) => h.id)).toEqual(["ep-fresh", "ep-stale"]);
  });
});

describe("recordActedEpisode / recordErredEpisode (hot path + correction path)", () => {
  it("writes a templated acted episode from an approved proposal", async () => {
    const db = seedDb();
    const { client } = fakeClient(db);
    const id = await recordActedEpisode(client, COMPANY, { tool: "create_expense", summary: "Expense: $42.00 (fuel)" });
    expect(id).toBeTruthy();
    const row = db.agent_episodes!.find((r) => r.id === id)!;
    expect(row.kind).toBe("acted");
    expect(row.summary).toContain("create_expense");
    expect(row.valence).toBe("helped");
  });

  it("writes a templated erred episode capturing old -> new and the lesson", async () => {
    const db = seedDb();
    const { client } = fakeClient(db);
    const id = await recordErredEpisode(client, COMPANY, {
      oldText: "Carrier settles on Fridays",
      newText: "Carrier settles on Thursdays",
      context: "pay terms",
    });
    expect(id).toBeTruthy();
    const row = db.agent_episodes!.find((r) => r.id === id)!;
    expect(row.kind).toBe("erred");
    expect(row.lesson).toContain("Fridays");
    expect(row.lesson).toContain("Thursdays");
  });

  it("swallows failures — a failed episode write never breaks a turn", async () => {
    const broken = {
      from: () => { throw new Error("db down"); },
      rpc: async () => ({ data: null, error: { message: "no rpc" } }),
    } as unknown as SupabaseClient;
    await expect(recordActedEpisode(broken, COMPANY, { tool: "x", summary: "y" })).resolves.toBeNull();
    await expect(recordErredEpisode(broken, COMPANY, { oldText: "a", newText: "b" })).resolves.toBeNull();
    await expect(saveEpisode(broken, COMPANY, { kind: "said", summary: "x" })).rejects.toThrow();
  });
});

describe("synthesizeLearnedLessons (F1 verification on synthesis)", () => {
  const grounding = [
    "Pay: carrier settles Thursdays, $611.20 expected for Trip 1874",
    "Pay: $284.47 due on the Self Visa",
  ];
  it("drops a lesson quoting a superseded dollar figure, never stages it", () => {
    const kept = synthesizeLearnedLessons({
      lessons: [
        "Lesson learned: he usually turns down morning digests (3 of 3) - only suggest them when he asks.",
        // Quotes ONLY the superseded $500.00 (the fresh figure is
        // $611.20) — staleFiguresInReply flags it; the lesson dies.
        "Lesson learned: Trip 1874 pays $500.00 - quote that when he asks about the trip.",
      ],
      existingLessons: [],
      groundingTexts: ["Trip 1874 pay: $500.00\nTrip 1874 pay: $611.20"],
    });
    // The second lesson quotes the superseded $500.00 figure.
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("morning digests");
  });
  it("keeps a clean lesson and drops a near-duplicate of an existing lesson (>= 0.9)", () => {
    const kept = synthesizeLearnedLessons({
      lessons: ["Lesson learned: he usually turns down morning digests (3 of 3)."],
      existingLessons: ["Lesson learned: he usually turns down morning digests (3 of 3)."],
      groundingTexts: grounding,
    });
    expect(kept).toEqual([]);
  });
  it("keeps a clean, genuinely new lesson", () => {
    const kept = synthesizeLearnedLessons({
      lessons: ["Lesson learned: he usually turns down morning digests (3 of 3)."],
      existingLessons: ["Something entirely different about fuel stops."],
      groundingTexts: grounding,
    });
    expect(kept).toHaveLength(1);
  });
});
