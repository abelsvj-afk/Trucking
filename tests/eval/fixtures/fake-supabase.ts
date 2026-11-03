// Phase F eval fixture — an in-memory Supabase fake that speaks
// BOTH dialects the merged Phase A+B code uses:
//
// - the plain PostgREST query builder (select/insert/update/upsert
//   with eq/is/in/gte/lt/ilike filters, ordering, limits, count
//   heads, single/maybeSingle), and
// - the migration-00029 RPC contract: abel_search_memories /
//   abel_search_messages / abel_search_documents with the SQL
//   functions' documented behavior — current-facts-only unless
//   p_include_history, FTS arm + vector arm fused with reciprocal
//   rank fusion (using the PRODUCTION fuseRrf, so the fusion the
//   harness exercises is the repo's own), p_limit honored.
//
// rpcMode "absent" makes every rpc() fail with "function does not
// exist" — the pre-00029 database — which drives production code
// down its fallback arms exactly as the live system behaves before
// the owner applies the migration.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fuseRrf } from "@/services/bot/memory-retrieval";
import { tokenSet } from "@/services/bot/memory-lifecycle";
import { conceptVector, cosine, parseVectorLiteral } from "./concept-embedder";

export type Row = Record<string, unknown>;
export type EvalDb = Record<string, Row[]>;

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

let insertCounter = 0;

class FakeQuery {
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private countHead = false;

  constructor(
    private db: EvalDb,
    private table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.countHead = true;
    return this;
  }
  insert(payload: Row) { this.op = "insert"; this.payload = payload; return this; }
  update(payload: Row) { this.op = "update"; this.payload = payload; return this; }
  upsert(payload: Row) { this.op = "upsert"; this.payload = payload; return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ op: "gte", col, val }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ op: "lt", col, val }); return this; }
  in(col: string, val: unknown) { this.filters.push({ op: "in", col, val }); return this; }
  ilike(col: string, val: unknown) { this.filters.push({ op: "ilike", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private execute(single: boolean, maybe: boolean) {
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert") {
      insertCounter += 1;
      const row: Row = {
        id: `ins-${this.table}-${insertCounter}`,
        created_at: new Date().toISOString(),
        ...this.payload,
      };
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
    const matched = rows.filter((row) => matches(row, this.filters));
    if (this.countHead) return { data: null, error: null, count: matched.length };
    let sorted = matched;
    if (this.orderCol) {
      const col = this.orderCol;
      sorted = [...matched].sort((a, b) => {
        const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN != null) sorted = sorted.slice(0, this.limitN);
    if (single) {
      return { data: sorted[0] ?? null, error: sorted[0] ? null : { message: "no rows" }, count: null };
    }
    if (maybe) return { data: sorted[0] ?? null, error: null, count: null };
    return { data: sorted, error: null, count: sorted.length };
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

/** Token-overlap ranking (the FTS arm's stand-in): overlap desc, ties break toward the NEWEST row — the production fallback scan reads newest-first and breaks ties by scan position, so the fake pre-sorts by recency to mirror it. */
function rankByOverlap<T extends Row>(rows: T[], textOf: (row: T) => string, query: string): T[] {
  const queryTokens = tokenSet(query);
  const byRecency = [...rows].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
  );
  return byRecency
    .map((row, index) => {
      const words = tokenSet(textOf(row));
      let overlap = 0;
      for (const token of words) if (queryTokens.has(token)) overlap += 1;
      return { row, index, overlap };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .map((s) => s.row);
}

/** Vector ranking over precomputed-at-read concept vectors (the fixture's stand-in for stored pgvector columns); similarity ties break toward the newest row. */
function rankByVector<T extends Row>(rows: T[], textOf: (row: T) => string, queryVector: number[] | null): T[] {
  if (!queryVector) return [];
  return rows
    .map((row) => ({ row, sim: cosine(queryVector, conceptVector(textOf(row))) }))
    .filter((s) => s.sim > 0)
    .sort(
      (a, b) =>
        b.sim - a.sim ||
        String(b.row.created_at ?? "").localeCompare(String(a.row.created_at ?? "")),
    )
    .map((s) => s.row);
}

/** FTS list + vector list fused by the production RRF — the SQL functions' contract, mirrored. */
function hybridRank<T extends Row & { id: string }>(
  rows: T[],
  textOf: (row: T) => string,
  query: string,
  embeddingLiteral: string | null | undefined,
  limit: number,
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const fts = rankByOverlap(rows, textOf, query).map((r) => r.id);
  const vec = rankByVector(rows, textOf, parseVectorLiteral(embeddingLiteral)).map((r) => r.id);
  return fuseRrf([fts, vec])
    .slice(0, limit)
    .map((f) => byId.get(f.id))
    .filter((r): r is T => Boolean(r));
}

export interface EvalClientOptions {
  /** "hybrid" = the 00029 functions exist; "absent" = pre-migration database, every rpc errors. */
  rpcMode: "hybrid" | "absent";
}

export function createEvalClient(db: EvalDb, options: EvalClientOptions): SupabaseClient {
  const rpc = async (fn: string, args: Row): Promise<{ data: unknown; error: { message: string } | null }> => {
    if (options.rpcMode === "absent") {
      return { data: null, error: { message: `function ${fn} does not exist` } };
    }
    const companyId = args.p_company_id as string;
    const query = String(args.p_query ?? "");
    const limit = typeof args.p_limit === "number" ? args.p_limit : 8;
    const embedding = args.p_embedding as string | null | undefined;

    if (fn === "abel_search_memories") {
      const includeHistory = args.p_include_history === true;
      const rows = (db.bot_memories ?? []).filter(
        (row) =>
          row.company_id === companyId &&
          (row.deleted_at === null || row.deleted_at === undefined) &&
          (includeHistory || row.valid_to === null || row.valid_to === undefined),
      ) as (Row & { id: string })[];
      const ranked = hybridRank(rows, (r) => String(r.content ?? ""), query, embedding, limit);
      return {
        data: ranked.map((r) => ({ id: r.id, kind: r.kind, content: r.content, created_at: r.created_at })),
        error: null,
      };
    }
    if (fn === "abel_search_messages") {
      const rows = (db.telegram_messages ?? []).filter(
        (row) => row.company_id === companyId && (row.deleted_at === null || row.deleted_at === undefined),
      ) as (Row & { id: string })[];
      const ranked = hybridRank(rows, (r) => String(r.text ?? ""), query, embedding, limit);
      return {
        data: ranked.map((r) => ({ id: r.id, text: r.text, created_at: r.created_at })),
        error: null,
      };
    }
    if (fn === "abel_search_documents") {
      const rows = (db.documents ?? []).filter((row) => row.company_id === companyId) as (Row & { id: string })[];
      const ranked = hybridRank(rows, (r) => String(r.extracted_text ?? ""), query, embedding, limit);
      return {
        data: ranked.map((r) => ({
          id: r.id,
          file_name: r.file_name,
          extracted_text: r.extracted_text ?? null,
          created_at: r.created_at,
        })),
        error: null,
      };
    }
    return { data: null, error: { message: `function ${fn} does not exist` } };
  };

  return {
    from: (table: string) => new FakeQuery(db, table),
    rpc,
  } as unknown as SupabaseClient;
}
