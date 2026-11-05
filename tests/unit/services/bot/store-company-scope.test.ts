import { describe, expect, it, vi } from "vitest";
import { createBotStore } from "@/services/bot/store";
import { buildBotTools } from "@/services/bot/tools";

// Wave 4 gate (docs/reconciliation/wave-4-test-matrix.md §3, item 1): the Telegram brain store runs
// with the SERVICE ROLE, so RLS cannot protect it - company scoping lives in code. This test drives
// every store method with a recording client and asserts that EVERY query it issues is scoped to the
// configured company: reads/updates/deletes carry `company_id = A`, writes carry `company_id: A`.
// It cannot prove company B's rows stay unread against a real database (that needs the DB harness), but it
// proves no query can even ask for them - and it fails the moment a new method forgets the filter.

const A = "00000000-0000-0000-0000-00000000aaaa";

interface Recorded {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete" | "rpc";
  filters: Record<string, unknown>;
  payload: unknown;
  calls: string[];
}

function recordingClient() {
  const queries: Recorded[] = [];
  const rpcs: { name: string; params: unknown }[] = [];
  const from = (table: string) => {
    const q: Recorded = { table, op: "select", filters: {}, payload: undefined, calls: [] };
    queries.push(q);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            // A bare await resolves like an empty result; the shape callers get is `{ data, error, count }`.
            return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
          }
          return (...args: unknown[]) => {
            q.calls.push(prop + "(" + args.map((a) => JSON.stringify(a)).join(",") + ")");
            if (prop === "insert" || prop === "upsert" || prop === "update") {
              q.op = prop as Recorded["op"];
              q.payload = args[0];
            } else if (prop === "delete") {
              q.op = "delete";
            } else if (prop === "eq" || prop === "match") {
              if (prop === "eq") q.filters[String(args[0])] = args[1];
              else Object.assign(q.filters, args[0] as object);
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
  const client = {
    from,
    rpc: (name: string, params: unknown) => {
      rpcs.push({ name, params });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client, queries, rpcs };
}

// Argument shapes tried against every method: the point is to reach the queries, not to exercise logic.
const ARG_SETS: unknown[][] = [
  [],
  ["x"],
  ["x", "x"],
  ["x", "x", "x"],
  [1],
  [1, "x"],
  ["x", {}],
  [{}],
  [{ toolName: "t", args: {}, summary: "s", batchId: "b", itemNumber: 1, confidence: "high" }],
  [["a", "b"]],
  ["2026-11-01", "2026-11-07"],
];

describe("Telegram brain store: every query is scoped to the configured company (service role)", () => {
  it("scopes every select/update/delete with company_id and stamps every insert/upsert with it", async () => {
    const { client, queries } = recordingClient();
    const store = createBotStore(client as never, A, "telegram") as unknown as Record<string, unknown>;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    let called = 0;
    for (const [name, fn] of Object.entries(store)) {
      if (typeof fn !== "function") continue;
      for (const args of ARG_SETS) {
        try {
          await (fn as (...a: unknown[]) => Promise<unknown>).apply(store, args);
        } catch {
          // Argument-shape errors are expected; only the queries reached before them matter.
        }
      }
      called += 1;
      expect(name.length).toBeGreaterThan(0);
    }
    spy.mockRestore();

    expect(called).toBeGreaterThan(40); // the surface is large; this guards against the loop silently doing nothing
    expect(queries.filter((q) => q.calls.length > 0).length).toBeGreaterThan(40);

    const unscoped: string[] = [];
    for (const q of queries) {
      // A query whose chain never ran (an argument threw while being built) asked for nothing.
      if (q.calls.length === 0) continue;
      if (q.op === "select" || q.op === "update" || q.op === "delete") {
        const scoped = q.filters.company_id === A || (q.table === "companies" && q.filters.id === A);
        if (!scoped) unscoped.push(`${q.op} ${q.table} (filters: ${JSON.stringify(q.filters)}; calls: ${q.calls.join(" ")})`);
      } else {
        const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
        for (const row of rows) {
          if (!row || typeof row !== "object" || (row as Record<string, unknown>).company_id !== A) {
            unscoped.push(`${q.op} ${q.table} (payload company_id: ${JSON.stringify((row as Record<string, unknown> | undefined)?.company_id)})`);
          }
        }
      }
    }
    expect(unscoped, `queries not scoped to the configured company:\n${[...new Set(unscoped)].join("\n")}`).toEqual([]);
  });

  it("every bot tool (read and write) is scoped to the configured company too", async () => {
    const { client, queries } = recordingClient();
    const store = createBotStore(client as never, A, "telegram");
    const tools = buildBotTools(store);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = "11111111-1111-4111-8111-111111111111";
    const argSets: Record<string, unknown>[] = [
      {},
      { id, load_id: id, record_id: id, truck_id: id, driver_id: id, entity: "expense", query: "x", name: "x", text: "x", limit: 5, start_date: "2026-11-01", end_date: "2026-11-07", week_start: "2026-11-02" },
    ];
    for (const tool of tools) {
      for (const args of argSets) {
        try {
          await tool.run(args);
        } catch {
          // validation / shape errors are fine; the queries reached before them are what matter
        }
      }
    }
    spy.mockRestore();

    expect(tools.length).toBeGreaterThan(50);
    expect(queries.filter((q) => q.calls.length > 0).length).toBeGreaterThan(30); // the tools really reached their queries
    const unscoped: string[] = [];
    for (const q of queries) {
      if (q.calls.length === 0) continue;
      if (q.op === "select" || q.op === "update" || q.op === "delete") {
        const scoped = q.filters.company_id === A || (q.table === "companies" && q.filters.id === A);
        if (!scoped) unscoped.push(`${q.op} ${q.table} (${q.calls.join(" ")})`);
      } else {
        const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
        for (const row of rows) {
          if (!row || typeof row !== "object" || (row as Record<string, unknown>).company_id !== A) unscoped.push(`${q.op} ${q.table} (no company_id in payload)`);
        }
      }
    }
    expect(unscoped, `tool queries not scoped to the configured company:\n${[...new Set(unscoped)].join("\n")}`).toEqual([]);
  });
});
