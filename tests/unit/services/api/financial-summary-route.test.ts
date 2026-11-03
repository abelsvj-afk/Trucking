// GET /api/v1/financial-summary + /detail (Reliability Unit C -
// design C.2/C.3, F-008/F-010/F-033, ruling D-01).
//
// The endpoint no longer reads through PostgREST: it runs the
// snapshot transaction over a direct connection (services/financial-
// summary/snapshot.ts). These tests drive the REAL route + REAL
// transaction runner against a fake connection whose store simulates
// the database honestly: the snapshot is captured at BEGIN, RLS is
// applied from the JWT claims the transaction establishes (the fake
// resolves company from the claims' sub via a profiles map, exactly
// as current_company_id() does), and the read functions reproduce
// migration 00044's filters. Live-database proof of the SQL itself
// remains a post-deploy gate; what is proven here is the endpoint's
// contract: recognition, pipeline, exceptions, the unverified state,
// two-company isolation through the real code path (C.7.3c(c)), and
// detail reconciliation (C.7.4's property at the API level).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn(),
}));

vi.mock("@/services/db/financial-summary-pool", () => ({
  getFinancialSummaryPool: vi.fn(),
}));

import { getAuthContext } from "@/services/auth";
import { getFinancialSummaryPool } from "@/services/db/financial-summary-pool";
import { GET } from "@/app/api/v1/financial-summary/route";
import { GET as GET_DETAIL } from "@/app/api/v1/financial-summary/detail/route";

type Row = Record<string, unknown> & { id: string; company_id: string };

interface Store {
  loads: Row[];
  expenses: Row[];
  fuel_purchases: Row[];
  maintenance_events: Row[];
}

const PROFILES: Record<string, string> = { u1: "company-1", u2: "company-2" };

let seq = 0;
function row(partial: Partial<Row> & { id: string }): Row {
  seq += 1;
  return {
    company_id: "company-1",
    deleted_at: null,
    created_at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    ...partial,
  } as Row;
}

function byCreatedThenId(a: Row, b: Row) {
  const ka = `${String(a.created_at)}|${a.id}`;
  const kb = `${String(b.created_at)}|${b.id}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

class FakeConnection {
  statements: string[] = [];
  released = false;
  private snapshot: Store | null = null;
  private claimsSub: string | null = null;

  constructor(
    private store: Store,
    private opts: {
      onSnapshotQuery?: () => void;
      corruptCounts?: boolean;
    } = {},
  ) {}

  private companyRows<T extends Row>(rows: T[]): T[] {
    const company = this.claimsSub ? PROFILES[this.claimsSub] : undefined;
    return rows.filter((r) => r.company_id === company && r.deleted_at == null);
  }

  private computeSnapshot(window: { from: string; to: string; fromTs: string; toTs: string }) {
    const t = this.snapshot!;
    const loads = this.companyRows(t.loads);
    const expenses = this.companyRows(t.expenses);
    const fuel = this.companyRows(t.fuel_purchases);
    const maintenance = this.companyRows(t.maintenance_events);

    const component = (rows: Row[], field: string) => ({
      total_cents: rows.reduce((s, r) => s + Number(r[field] ?? 0), 0),
      row_count: rows.length + (this.opts.corruptCounts ? 1 : 0),
      record_ids: rows.map((r) => r.id),
    });

    const revenueRows = loads
      .filter(
        (l) =>
          l.status === "completed" &&
          l.delivery_date != null &&
          String(l.delivery_date) >= window.from &&
          String(l.delivery_date) <= window.to,
      )
      .sort(byCreatedThenId);
    const pipelineRows = loads
      .filter((l) => l.status === "draft" || l.status === "confirmed")
      .sort(byCreatedThenId);
    const missingRows = loads
      .filter((l) => l.status === "completed" && l.delivery_date == null)
      .sort(byCreatedThenId);
    const expenseRows = expenses
      .filter((e) => String(e.expense_date) >= window.from && String(e.expense_date) <= window.to)
      .sort(byCreatedThenId);
    const fuelRows = fuel
      .filter((f) => String(f.purchased_at) >= window.fromTs && String(f.purchased_at) < window.toTs)
      .sort(byCreatedThenId);
    const maintenanceRows = maintenance
      .filter((m) => String(m.service_date) >= window.from && String(m.service_date) <= window.to)
      .sort(byCreatedThenId);

    return {
      revenue: component(revenueRows, "rate_cents"),
      expenses: component(expenseRows, "amount_cents"),
      fuel: component(fuelRows, "total_cost_cents"),
      maintenance: component(maintenanceRows, "cost_cents"),
      pipeline: {
        ...component(pipelineRows, "rate_cents"),
        loads_without_rate_count: pipelineRows.filter((l) => l.rate_cents == null).length,
      },
      completed_missing_delivery_date: {
        count: missingRows.length,
        record_ids: missingRows.map((r) => r.id),
      },
      assigned_expenses: expenses
        .filter((e) => e.load_id != null)
        .sort(byCreatedThenId)
        .map((e) => ({
          load_id: e.load_id,
          amount_cents: e.amount_cents,
          expense_date: e.expense_date,
        })),
      unassigned_expenses_in_period_cents: expenseRows
        .filter((e) => e.load_id == null)
        .reduce((s, e) => s + Number(e.amount_cents ?? 0), 0),
      _detail: { revenueRows, expensesRows: expenseRows, fuelRows, maintenanceRows },
    };
  }

  async query(text: string, params?: unknown[]) {
    this.statements.push(text);
    if (text.startsWith("BEGIN")) {
      this.snapshot = structuredClone(this.store);
      return { rows: [] };
    }
    if (text.includes("set_config")) {
      const claims = JSON.parse(String(params?.[0]));
      this.claimsSub = claims.sub;
      return { rows: [] };
    }
    if (text.includes("current_setting('transaction_isolation')")) {
      return {
        rows: [
          {
            isolation: this.statements[0]?.includes("REPEATABLE READ")
              ? "repeatable read"
              : "read committed",
          },
        ],
      };
    }
    if (text.includes("financial_summary_detail")) {
      const window = {
        from: String(params?.[1]),
        to: String(params?.[2]),
        fromTs: String(params?.[3]),
        toTs: String(params?.[4]),
      };
      const snap = this.computeSnapshot(window);
      const key = `${String(params?.[0])}Rows` as keyof typeof snap._detail;
      return { rows: snap._detail[key].map((r) => ({ row: r })) };
    }
    if (text.includes("financial_summary_snapshot")) {
      this.opts.onSnapshotQuery?.();
      const window = {
        from: String(params?.[0]),
        to: String(params?.[1]),
        fromTs: String(params?.[2]),
        toTs: String(params?.[3]),
      };
      const { _detail: _ignored, ...snapshot } = this.computeSnapshot(window);
      return { rows: [{ snapshot }] };
    }
    return { rows: [] };
  }

  release() {
    this.released = true;
  }
}

let store: Store;
let connection: FakeConnection;

function installFake(opts: { onSnapshotQuery?: () => void; corruptCounts?: boolean } = {}) {
  connection = new FakeConnection(store, opts);
  vi.mocked(getFinancialSummaryPool).mockReturnValue({
    connect: async () => connection,
  } as never);
}

function authAs(userId: string, companyId: string) {
  vi.mocked(getAuthContext).mockResolvedValue({ userId, companyId, role: "owner" });
}

beforeEach(() => {
  seq = 0;
  store = { loads: [], expenses: [], fuel_purchases: [], maintenance_events: [] };
  authAs("u1", "company-1");
  installFake();
});

afterEach(() => {
  vi.useRealTimers();
});

const summaryReq = (qs: string) => new NextRequest(`http://localhost/api/v1/financial-summary?${qs}`);
const detailReq = (qs: string) =>
  new NextRequest(`http://localhost/api/v1/financial-summary/detail?${qs}`);

describe("GET /api/v1/financial-summary", () => {
  it("rejects a malformed date and from-after-to before touching the database", async () => {
    expect((await GET(summaryReq("from=08-01-2026&to=2026-08-31"))).status).toBe(400);
    expect((await GET(summaryReq("from=2026-08-31&to=2026-08-01"))).status).toBe(400);
    expect(connection.statements).toHaveLength(0);
  });

  it("C.7.1 + C.7.2: revenue is recognized on delivery only; pipeline and the missing-date exception are surfaced, never merged in", async () => {
    store.loads.push(
      // Picked up Oct 30, delivered Nov 2, $2,000.
      row({ id: "L1", status: "completed", pickup_date: "2026-10-30", delivery_date: "2026-11-02", rate_cents: 200000 }),
      // Booked in October, not delivered: pipeline.
      row({ id: "L2", status: "confirmed", pickup_date: "2026-10-30", delivery_date: null, rate_cents: 99900 }),
      // Completed with no delivery date: the named exception.
      row({ id: "L3", status: "completed", pickup_date: "2026-10-05", delivery_date: null, rate_cents: 50000 }),
      // Cancelled: in neither figure.
      row({ id: "L4", status: "cancelled", pickup_date: "2026-10-06", delivery_date: null, rate_cents: 70000 }),
      // Pipeline load with no rate: $0 + counted in the note.
      row({ id: "L5", status: "draft", pickup_date: null, delivery_date: null, rate_cents: null }),
    );

    const octRes = await GET(summaryReq("from=2026-10-01&to=2026-10-31&tz=America/New_York"));
    expect(octRes.status).toBe(200);
    const oct = await octRes.json();
    expect(oct.revenue_cents).toBe(0);
    expect(oct.components.revenue.record_ids).toEqual([]);
    expect(oct.pipeline.total_cents).toBe(99900);
    expect(oct.pipeline.record_ids).toEqual(["L2", "L5"]);
    expect(oct.pipeline.loadsWithoutRateCount).toBe(1);
    expect(oct.exceptions.completedMissingDeliveryDate).toEqual({ count: 1, record_ids: ["L3"] });
    // Pipeline is never added to revenue or net.
    expect(oct.net_cents).toBe(0);

    const novRes = await GET(summaryReq("from=2026-11-01&to=2026-11-30&tz=America/New_York"));
    const nov = await novRes.json();
    expect(nov.revenue_cents).toBe(200000);
    expect(nov.components.revenue.record_ids).toEqual(["L1"]);
    expect(nov.measures.recognizedRevenue).toBe(200000);
  });

  it("reports the convention and the resolved timezone with the data (C.7.8, API half)", async () => {
    const res = await GET(summaryReq("from=2026-08-01&to=2026-08-31&tz=America%2FChicago"));
    const body = await res.json();
    expect(body.revenueConvention).toBe("recognized_on_delivery");
    expect(body.timeZone).toBe("America/Chicago");

    const fallback = await (await GET(summaryReq("from=2026-08-01&to=2026-08-31&tz=Bogus%2FZone"))).json();
    expect(fallback.timeZone).toBe("America/New_York");
  });

  it("defaults to the current viewer-local month when no range is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    store.loads.push(
      row({ id: "L1", status: "completed", pickup_date: "2026-11-01", delivery_date: "2026-11-10", rate_cents: 12300 }),
    );
    const body = await (await GET(summaryReq("tz=America/New_York"))).json();
    expect(body.range).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(body.revenue_cents).toBe(12300);
  });

  it("C.7.3c(c): exercised as company B, the endpoint returns company B's components only - company A's rows are absent", async () => {
    store.loads.push(
      row({ id: "A1", status: "completed", delivery_date: "2026-11-03", pickup_date: "2026-11-01", rate_cents: 11100 }),
      row({ id: "B1", company_id: "company-2", status: "completed", delivery_date: "2026-11-04", pickup_date: "2026-11-02", rate_cents: 22200 }),
    );
    store.expenses.push(row({ id: "BEXP", company_id: "company-2", amount_cents: 3300, expense_date: "2026-11-05", load_id: null }));

    authAs("u2", "company-2");
    const body = await (await GET(summaryReq("from=2026-11-01&to=2026-11-30"))).json();
    expect(body.revenue_cents).toBe(22200);
    expect(body.components.revenue.record_ids).toEqual(["B1"]);
    expect(body.expenses_cents).toBe(3300);
  });

  it("a concurrent insert during the call is not in the answer (the snapshot, end to end)", async () => {
    store.expenses.push(row({ id: "X1", amount_cents: 10000, expense_date: "2026-11-10", load_id: null }));
    installFake({
      onSnapshotQuery: () => {
        store.expenses.push(
          row({ id: "X2", amount_cents: 5000, expense_date: "2026-11-11", load_id: null }),
        );
      },
    });
    const body = await (await GET(summaryReq("from=2026-11-01&to=2026-11-30"))).json();
    expect(body.expenses_cents).toBe(10000);
    expect(body.components.expenses.record_ids).toEqual(["X1"]);
  });

  it("C.7.3: a count/ID mismatch inside the snapshot is the visible unverified state - no totals at all", async () => {
    store.expenses.push(row({ id: "X1", amount_cents: 10000, expense_date: "2026-11-10", load_id: null }));
    installFake({ corruptCounts: true });
    const res = await GET(summaryReq("from=2026-11-01&to=2026-11-30"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("SUMMARY_UNVERIFIED");
    expect(body.revenue_cents).toBeUndefined();
    expect(body.expenses_cents).toBeUndefined();
  });

  it("fuel is windowed by viewer-local midnights: an 11pm purchase on the last day counts, a 1am purchase on the 1st does not", async () => {
    store.fuel_purchases.push(
      row({ id: "F1", total_cost_cents: 4000, purchased_at: "2026-12-01T04:00:00.000Z" }), // Nov 30 23:00 EST
      row({ id: "F2", total_cost_cents: 9000, purchased_at: "2026-12-01T06:00:00.000Z" }), // Dec 1 01:00 EST
    );
    const body = await (await GET(summaryReq("from=2026-11-01&to=2026-11-30&tz=America/New_York"))).json();
    expect(body.fuel_cents).toBe(4000);
    expect(body.components.fuel.record_ids).toEqual(["F1"]);
  });
});

describe("GET /api/v1/financial-summary/detail (F-010)", () => {
  beforeEach(() => {
    store.loads.push(
      row({ id: "L1", status: "completed", pickup_date: "2026-11-01", delivery_date: "2026-11-02", rate_cents: 200000, origin: "A", destination: "B" }),
    );
    store.expenses.push(
      row({ id: "X1", amount_cents: 10000, expense_date: "2026-11-10", load_id: null, category: "other" }),
      row({ id: "X2", amount_cents: 5000, expense_date: "2026-11-12", load_id: null, category: "other" }),
    );
    store.fuel_purchases.push(
      row({ id: "F1", total_cost_cents: 40000, purchased_at: "2026-11-10T15:00:00.000Z", gallons: 100, price_per_gallon_cents: 400, adjustment_cents: 0, adjustment_reason: null }),
    );
  });

  it("rejects an unknown component", async () => {
    const res = await GET_DETAIL(detailReq("component=profit&from=2026-11-01&to=2026-11-30"));
    expect(res.status).toBe(400);
  });

  it("C.7.4 property at the API level: detail rows sum exactly to the summary totals", async () => {
    const summary = await (await GET(summaryReq("from=2026-11-01&to=2026-11-30"))).json();

    const expensesDetail = await (await GET_DETAIL(detailReq("component=expenses&from=2026-11-01&to=2026-11-30"))).json();
    expect(expensesDetail.total_cents).toBe(summary.expenses_cents);
    expect(
      expensesDetail.rows.reduce((s: number, r: Row) => s + Number(r.amount_cents), 0),
    ).toBe(summary.expenses_cents);

    const revenueDetail = await (await GET_DETAIL(detailReq("component=revenue&from=2026-11-01&to=2026-11-30"))).json();
    expect(revenueDetail.rows.map((r: Row) => r.id)).toEqual(["L1"]);
    expect(revenueDetail.total_cents).toBe(summary.revenue_cents);

    const fuelDetail = await (await GET_DETAIL(detailReq("component=fuel&from=2026-11-01&to=2026-11-30"))).json();
    expect(fuelDetail.total_cents).toBe(summary.fuel_cents);
  });

  it("condition 6: the detail endpoint runs the SAME snapshot transaction - BEGIN ISOLATION LEVEL REPEATABLE READ on its connection", async () => {
    await GET_DETAIL(detailReq("component=expenses&from=2026-11-01&to=2026-11-30"));
    expect(connection.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(connection.statements.some((s) => s.includes("SET LOCAL ROLE authenticated"))).toBe(true);
  });
});
