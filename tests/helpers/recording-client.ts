// A Supabase-shaped client that records every query chain instead of running it, for the
// service-role company-scope tests (docs/reconciliation/wave-4-test-matrix.md §3). Service-role code
// bypasses RLS, so company scoping lives in code; these tests assert no executed query can ask for, or
// write, another company's rows. Not a database: it cannot prove two seeded companies stay separate end to end.

export interface Recorded {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  filters: Record<string, unknown>;
  payload: unknown;
  calls: string[];
}

export function recordingClient() {
  const queries: Recorded[] = [];
  const from = (table: string) => {
    const q: Recorded = { table, op: "select", filters: {}, payload: undefined, calls: [] };
    queries.push(q);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
          }
          return (...args: unknown[]) => {
            q.calls.push(prop + "(" + args.map((a) => JSON.stringify(a)).join(",") + ")");
            if (prop === "insert" || prop === "upsert" || prop === "update") {
              q.op = prop;
              q.payload = args[0];
            } else if (prop === "delete") {
              q.op = "delete";
            } else if (prop === "eq") {
              q.filters[String(args[0])] = args[1];
            } else if (prop === "match") {
              Object.assign(q.filters, args[0] as object);
            } else if (prop === "single" || prop === "maybeSingle") {
              return Promise.resolve({ data: null, error: null });
            }
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return {
    client: { from, rpc: () => Promise.resolve({ data: null, error: null }) },
    queries,
  };
}

/** Executed queries that are not scoped to `companyId` (empty = every executed query is scoped). */
export function unscopedQueries(queries: Recorded[], companyId: string): string[] {
  const out: string[] = [];
  for (const q of queries) {
    if (q.calls.length === 0) continue; // a chain that never ran (an argument threw while being built)
    if (q.op === "select" || q.op === "update" || q.op === "delete") {
      const scoped = q.filters.company_id === companyId || (q.table === "companies" && q.filters.id === companyId);
      if (!scoped) out.push(`${q.op} ${q.table} (${q.calls.join(" ")})`);
    } else {
      const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
      for (const row of rows) {
        if (!row || typeof row !== "object" || (row as Record<string, unknown>).company_id !== companyId) {
          out.push(`${q.op} ${q.table} (payload company_id: ${JSON.stringify((row as Record<string, unknown> | undefined)?.company_id)})`);
        }
      }
    }
  }
  return [...new Set(out)];
}
