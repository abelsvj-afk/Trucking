// Phase E acceptance (design §7 Phase E tests 2-3, store side):
// sent-reply capture computes the edit distance IN CODE and
// stores it; the decision log answers with counts or admits thin
// history; the twin + transcription switches default OFF (no
// settings row = off, the house convention). Before migration
// 00050, capture fails with a plain not-applied message.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";

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
      case "not-is":
        return value !== null && value !== undefined;
      case "gte":
        return String(value) >= String(f.val);
      case "lte":
        return String(value) <= String(f.val);
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
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | Row[] | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(
    private db: Record<string, Row[]>,
    private missingTables: Set<string>,
    private missingColumns: Set<string>,
    private table: string,
    private stamp: () => string,
  ) {}

  select(cols?: string) {
    if (cols) {
      for (const col of cols.split(",").map((c) => c.trim())) {
        if (this.missingColumns.has(`${this.table}.${col}`)) this.columnError = col;
      }
    }
    return this;
  }
  private columnError: string | null = null;
  insert(payload: Row | Row[]) { this.op = "insert"; this.payload = payload; return this; }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    for (const col of Object.keys(payload)) {
      if (this.missingColumns.has(`${this.table}.${col}`)) this.columnError = col;
    }
    return this;
  }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  not(col: string, op: string, val: unknown) { if (op === "is" && val === null) this.filters.push({ op: "not-is", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ op: "gte", col, val }); return this; }
  lte(col: string, val: unknown) { this.filters.push({ op: "lte", col, val }); return this; }
  ilike(col: string, val: unknown) { this.filters.push({ op: "ilike", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private execute(single: boolean, maybe: boolean) {
    if (this.missingTables.has(this.table)) {
      return { data: null, error: { message: `relation "public.${this.table}" does not exist`, code: "42P01" }, count: null };
    }
    if (this.columnError) {
      return { data: null, error: { message: `column dispatch_exchanges.${this.columnError} does not exist`, code: "42703" }, count: null };
    }
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted = payloads.map((payload) => {
        const row: Row = {
          id: `row-${this.table}-${rows.length + 1}`,
          created_at: this.stamp(),
          valid_to: null,
          deleted_at: null,
          ...payload,
        };
        rows.push(row);
        return row;
      });
      return { data: single || maybe ? inserted[0] ?? null : inserted, error: null, count: null };
    }
    if (this.op === "update") {
      const clean = Object.fromEntries(Object.entries(this.payload as Row).filter(([, v]) => v !== undefined));
      for (const row of rows) if (matches(row, this.filters)) Object.assign(row, clean);
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
    if (single) {
      return matched[0]
        ? { data: matched[0], error: null, count: null }
        : { data: null, error: { message: "no rows" }, count: null };
    }
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
let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 10, 2, 0, 0, tick++)).toISOString();

function fakeStore(
  db: Record<string, Row[]>,
  options: { missingTables?: Set<string>; missingColumns?: Set<string> } = {},
): BotBrainStore {
  const client = {
    from: (table: string) =>
      new FakeQuery(db, options.missingTables ?? new Set(), options.missingColumns ?? new Set(), table, stamp),
    rpc: async () => ({ data: null, error: { message: "no rpc in fake" } }),
  } as unknown as SupabaseClient;
  return createBotStore(client, COMPANY, "telegram");
}

function seedExchange(db: Record<string, Row[]>) {
  (db.dispatch_exchanges ??= []).push({
    id: "ex-1",
    company_id: COMPANY,
    incoming_message: "Can you confirm the Dallas pickup?",
    ai_suggested_reply_en: "Yes, I confirm the Dallas pickup for 8am",
    ai_suggested_reply_es: null,
    actual_reply_sent: null,
    created_at: "2026-11-01T00:00:00.000Z",
    deleted_at: null,
  });
}

describe("twin switches default OFF", () => {
  it("no capability rows -> voice transcription and driver twin are both off", async () => {
    const db: Record<string, Row[]> = {};
    (db.companies ??= []).push({ id: COMPANY, ai_globally_disabled: false });
    const store = fakeStore(db);
    expect(await store.isDriverTwinEnabled()).toBe(false);
    expect(await store.isVoiceTranscriptionEnabled()).toBe(false);
    (db.ai_capability_settings ??= []).push({ company_id: COMPANY, capability: "driver_twin", enabled: true });
    expect(await store.isDriverTwinEnabled()).toBe(true);
  });
});

describe("recordSentReply", () => {
  it("stores his actual words and the code-computed edit distance", async () => {
    const db: Record<string, Row[]> = {};
    seedExchange(db);
    const store = fakeStore(db);
    const result = await store.recordSentReply("ex-1", "Yes I confirm the Dallas pickup for 8am");
    // draft 8 words, sent 8 words, one word different ("Yes," vs "Yes" counts equal after lowercase/split? - "Yes," tokenizes to "yes," vs "yes" = 1 substitution)
    expect(result.editDistanceRatio).not.toBeNull();
    expect(result.editDistanceRatio!).toBeGreaterThan(0);
    expect(result.editDistanceRatio!).toBeLessThan(0.5);
    const row = (db.dispatch_exchanges ?? [])[0]!;
    expect(row.actual_reply_sent).toBe("Yes I confirm the Dallas pickup for 8am");
    expect(row.edit_distance_ratio).toBe(result.editDistanceRatio);
    expect(row.reply_captured_at).toBeTruthy();
  });

  it("before migration 00050 the capture fails with a plain not-applied message", async () => {
    const db: Record<string, Row[]> = {};
    seedExchange(db);
    const store = fakeStore(db, {
      missingColumns: new Set(["dispatch_exchanges.edit_distance_ratio", "dispatch_exchanges.reply_captured_at"]),
    });
    await expect(store.recordSentReply("ex-1", "anything")).rejects.toThrow(/migration 00050/);
  });
});

describe("decision log", () => {
  it("records and lists his decisions; pre-00050 the read degrades and the write says so", async () => {
    const db: Record<string, Row[]> = {};
    const store = fakeStore(db);
    await store.recordLoadDecision({ description: "Memphis load, $1,900", decision: "passed", outcomeNote: null });
    await store.recordLoadDecision({ description: "Dallas load, $2,400", decision: "taken", outcomeNote: "Paid on time" });
    const decisions = await store.listLoadDecisions(10);
    expect(decisions).toHaveLength(2);
    expect(decisions.filter((d) => d.decision === "taken")).toHaveLength(1);

    const preStore = fakeStore({}, { missingTables: new Set(["load_decisions"]) });
    expect(await preStore.listLoadDecisions(10)).toEqual([]);
    await expect(
      preStore.recordLoadDecision({ description: "x", decision: "taken" }),
    ).rejects.toThrow(/migration 00050/);
  });
});

describe("voice exemplars through the store", () => {
  it("only exchanges with captured sent replies can teach; stats average the measured distances", async () => {
    const db: Record<string, Row[]> = {};
    seedExchange(db);
    (db.dispatch_exchanges ?? []).push({
      id: "ex-2",
      company_id: COMPANY,
      incoming_message: "Confirm Dallas delivery Friday",
      ai_suggested_reply_en: "Confirmed",
      ai_suggested_reply_es: null,
      actual_reply_sent: "Confirmed, see you Friday",
      created_at: "2026-11-01T01:00:00.000Z",
      deleted_at: null,
    });
    const store = fakeStore(db);
    const exemplars = await store.loadVoiceExemplars("Please confirm the Dallas pickup tomorrow");
    expect(exemplars.map((e) => e.exchangeId)).toEqual(["ex-2"]); // ex-1 has no sent reply yet

    await store.recordSentReply("ex-1", "Yes, I confirm the Dallas pickup for 8am");
    const stats = await store.twinEditStats("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
    expect(stats.count).toBe(1); // only ex-1 was captured in the window via recordSentReply
    expect(stats.avgDistance).not.toBeNull();
  });
});
