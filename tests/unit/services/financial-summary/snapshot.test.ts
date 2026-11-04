// Reliability Unit C (design C.3 Rev 6): the snapshot transaction
// machinery. The seven binding acceptance conditions are tested at
// the seam they bind: the exact statement sequence on ONE dedicated
// connection (lifecycle, condition 4), BEGIN ISOLATION LEVEL
// REPEATABLE READ as the FIRST statement with the in-transaction
// isolation probe (condition 7 / C.7.3c(a)), role + claims
// establishment from the verified AuthContext only - database role
// `authenticated`, never the business role (conditions 1, 2, 3) -
// and C.7.3b's concurrent-mutation fixture against a fake store
// whose snapshot is captured at BEGIN, so commits landing while the
// transaction is open are invisible to its reads: the response must
// be one of the four hand-calculated legal outcomes, never a blend.

import { describe, expect, it } from "vitest";
import {
  readSummaryDetail,
  readSummarySnapshot,
  runSummarySnapshot,
  SummaryUnverifiedError,
  type SnapshotConnection,
  type SnapshotConnectionProvider,
} from "@/services/financial-summary/snapshot";
import { componentWindow } from "@/services/financial-summary/filter";
import type { AuthContext } from "@/services/auth";

const AUTH: AuthContext = { userId: "user-1", companyId: "company-1", role: "owner" };
const WINDOW = componentWindow({ from: "2026-11-01", to: "2026-11-30" }, "America/New_York");

interface ExpenseRow {
  id: string;
  amount_cents: number;
  expense_date: string;
}

function snapshotJson(expenses: ExpenseRow[]) {
  const inPeriod = expenses.filter(
    (r) => r.expense_date >= "2026-11-01" && r.expense_date <= "2026-11-30",
  );
  const component = (rows: { id: string }[], total: number) => ({
    total_cents: total,
    row_count: rows.length,
    record_ids: rows.map((r) => r.id),
  });
  return {
    revenue: component([], 0),
    expenses: component(
      inPeriod,
      inPeriod.reduce((s, r) => s + r.amount_cents, 0),
    ),
    fuel: component([], 0),
    maintenance: component([], 0),
    pipeline: { ...component([], 0), loads_without_rate_count: 0 },
    completed_missing_delivery_date: { count: 0, record_ids: [] },
    assigned_expenses: [],
    unassigned_expenses_in_period_cents: 0,
  };
}

class FakeConnection implements SnapshotConnection {
  statements: { text: string; params?: unknown[] }[] = [];
  released = false;
  private snapshotRows: ExpenseRow[] | null = null;

  constructor(
    private store: { rows: ExpenseRow[] },
    private opts: {
      onSnapshotQuery?: () => void;
      probeOverride?: string;
      failOnSubstring?: string;
    } = {},
  ) {}

  async query(text: string, params?: unknown[]) {
    this.statements.push({ text, params });
    if (this.opts.failOnSubstring && text.includes(this.opts.failOnSubstring)) {
      throw new Error("simulated failure");
    }
    if (text.startsWith("BEGIN")) {
      // The snapshot is taken at the transaction's first query - the
      // fake captures the committed state at BEGIN, which precedes
      // every read this connection will serve.
      this.snapshotRows = structuredClone(this.store.rows);
      return { rows: [] };
    }
    if (text.includes("current_setting('transaction_isolation')")) {
      return {
        rows: [
          {
            isolation:
              this.opts.probeOverride ??
              (this.statements[0]?.text.includes("REPEATABLE READ")
                ? "repeatable read"
                : "read committed"),
          },
        ],
      };
    }
    if (text.includes("financial_summary_snapshot")) {
      this.opts.onSnapshotQuery?.();
      return { rows: [{ snapshot: snapshotJson(this.snapshotRows ?? []) }] };
    }
    return { rows: [] };
  }

  release() {
    this.released = true;
  }
}

function providerFor(conn: FakeConnection): SnapshotConnectionProvider {
  return { connect: async () => conn };
}

describe("runSummarySnapshot lifecycle (conditions 1-4, 7)", () => {
  it("issues BEGIN ISOLATION LEVEL REPEATABLE READ first, then role + claims from the verified userId, probes isolation, commits, releases", async () => {
    const conn = new FakeConnection({ rows: [] });
    const result = await runSummarySnapshot(
      AUTH,
      async () => "done",
      providerFor(conn),
    );
    expect(result).toBe("done");

    const texts = conn.statements.map((s) => s.text);
    expect(texts[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(texts[1]).toBe("SET LOCAL ROLE authenticated");
    expect(texts[2]).toContain("set_config('request.jwt.claims', $1, true)");
    // Claims come from the verified AuthContext's userId (condition
    // 1); the claims role is the DATABASE role - the business role
    // ("owner") is never a role target anywhere (condition 2).
    const claims = JSON.parse(String(conn.statements[2]!.params?.[0]));
    expect(claims).toEqual({ sub: "user-1", role: "authenticated" });
    expect(texts.some((t) => t.includes("SET LOCAL ROLE owner"))).toBe(false);
    expect(texts.some((t) => t.includes("current_setting('transaction_isolation')"))).toBe(true);
    expect(texts[texts.length - 1]).toBe("COMMIT");
    expect(conn.released).toBe(true);
  });

  it("rolls back and releases on any failure inside the work, surfacing only the unverified error", async () => {
    const conn = new FakeConnection({ rows: [] });
    await expect(
      runSummarySnapshot(
        AUTH,
        async () => {
          throw new Error("raw internal detail");
        },
        providerFor(conn),
      ),
    ).rejects.toBeInstanceOf(SummaryUnverifiedError);
    const texts = conn.statements.map((s) => s.text);
    expect(texts[texts.length - 1]).toBe("ROLLBACK");
    expect(conn.released).toBe(true);
  });

  it("fails unverified when the in-transaction probe does not read repeatable read (C.7.3c proof obligation)", async () => {
    const conn = new FakeConnection({ rows: [] }, { probeOverride: "read committed" });
    await expect(runSummarySnapshot(AUTH, async () => "x", providerFor(conn))).rejects.toBeInstanceOf(
      SummaryUnverifiedError,
    );
    expect(conn.statements.map((s) => s.text)).toContain("ROLLBACK");
  });

  it("fails unverified when the connection cannot even be opened (e.g. the server-only secret is unset)", async () => {
    const provider: SnapshotConnectionProvider = {
      connect: async () => {
        throw new Error("FINANCIAL_SUMMARY_DB_URL is not configured.");
      },
    };
    await expect(runSummarySnapshot(AUTH, async () => "x", provider)).rejects.toBeInstanceOf(
      SummaryUnverifiedError,
    );
  });
});

describe("C.7.3b concurrent mutation during the summary call", () => {
  const E1 = { id: "E1", amount_cents: 10000, expense_date: "2026-11-10" };
  const E2 = { id: "E2", amount_cents: 30000, expense_date: "2026-11-11" };
  const E3 = { id: "E3", amount_cents: 10000, expense_date: "2026-11-12" };
  const E4 = { id: "E4", amount_cents: 5000, expense_date: "2026-11-13" };
  // Padding: 200 expenses of 100c in the PRIOR period - realistic
  // volume that must never enter November's total.
  const padding: ExpenseRow[] = Array.from({ length: 200 }, (_, i) => ({
    id: `P${i}`,
    amount_cents: 100,
    expense_date: "2026-10-15",
  }));

  const LEGAL = new Set(["50000/3", "55000/4", "70000/4", "159900/4"]);

  async function runScenario(
    committedAtBegin: ExpenseRow[],
    mutateLiveStore: (rows: ExpenseRow[]) => void,
  ) {
    const store = { rows: structuredClone([...committedAtBegin, ...padding]) };
    const conn = new FakeConnection(store, {
      // The concurrent writer commits AFTER the snapshot opened -
      // while the endpoint's transaction is mid-flight.
      onSnapshotQuery: () => mutateLiveStore(store.rows),
    });
    const data = await runSummarySnapshot(AUTH, (q) => readSummarySnapshot(q, WINDOW), providerFor(conn));
    return data.components.expenses;
  }

  const m1 = (rows: ExpenseRow[]) => rows.push({ ...E4 });
  const m2 = (rows: ExpenseRow[]) => {
    rows.find((r) => r.id === "E1")!.amount_cents = 20000;
    rows.find((r) => r.id === "E2")!.amount_cents = 35000;
  };
  const m3a = (rows: ExpenseRow[]) => {
    rows.find((r) => r.id === "E3")!.amount_cents = 99900;
  };
  const m3b = (rows: ExpenseRow[]) => {
    rows.find((r) => r.id === "E3")!.amount_cents = 10000;
  };

  it("snapshot before M1: 50000c / 3, even though M1-M3 all commit during the call", async () => {
    const expenses = await runScenario([E1, E2, E3], (rows) => {
      m1(rows);
      m2(rows);
      m3a(rows);
      m3b(rows);
    });
    expect(expenses.total_cents).toBe(50000);
    expect(expenses.row_count).toBe(3);
    expect(expenses.record_ids).toEqual(["E1", "E2", "E3"]);
    expect(LEGAL.has(`${expenses.total_cents}/${expenses.row_count}`)).toBe(true);
  });

  it("snapshot after M1, before M2: 55000c / 4", async () => {
    const expenses = await runScenario([E1, E2, E3, E4], (rows) => {
      m2(rows);
      m3a(rows);
      m3b(rows);
    });
    expect(expenses.total_cents).toBe(55000);
    expect(expenses.record_ids).toEqual(["E1", "E2", "E3", "E4"]);
    expect(LEGAL.has(`${expenses.total_cents}/${expenses.row_count}`)).toBe(true);
  });

  it("snapshot after M2, outside the ABA window: 70000c / 4", async () => {
    const expenses = await runScenario(
      [
        { ...E1, amount_cents: 20000 },
        { ...E2, amount_cents: 35000 },
        E3,
        E4,
      ],
      (rows) => {
        m3a(rows);
        m3b(rows);
      },
    );
    expect(expenses.total_cents).toBe(70000);
    expect(expenses.row_count).toBe(4);
    expect(LEGAL.has(`${expenses.total_cents}/${expenses.row_count}`)).toBe(true);
  });

  it("snapshot inside the ABA window: 159900c / 4 - the ABA case Rev 4's design got wrong", async () => {
    const expenses = await runScenario(
      [
        { ...E1, amount_cents: 20000 },
        { ...E2, amount_cents: 35000 },
        { ...E3, amount_cents: 99900 },
        E4,
      ],
      (rows) => {
        m3b(rows);
      },
    );
    expect(expenses.total_cents).toBe(159900);
    expect(expenses.row_count).toBe(4);
    expect(LEGAL.has(`${expenses.total_cents}/${expenses.row_count}`)).toBe(true);
  });

  it("the in-snapshot count assertion fails loudly when count and IDs disagree (C.7.3)", async () => {
    const conn = {
      statements: [] as string[],
      released: false,
      async query(text: string) {
        this.statements.push(text);
        if (text.includes("financial_summary_snapshot")) {
          const snap = snapshotJson([E1, E2, E3]);
          // A truncated transfer: count says 3, only 2 IDs arrived.
          (snap.expenses as { record_ids: string[] }).record_ids = ["E1", "E2"];
          return { rows: [{ snapshot: snap }] };
        }
        if (text.includes("current_setting")) return { rows: [{ isolation: "repeatable read" }] };
        return { rows: [] };
      },
      release() {
        this.released = true;
      },
    };
    await expect(
      runSummarySnapshot(AUTH, (q) => readSummarySnapshot(q, WINDOW), providerFor(conn as never)),
    ).rejects.toBeInstanceOf(SummaryUnverifiedError);
  });
});

describe("readSummaryDetail reconciliation (F-010 property, service level)", () => {
  function detailConn(detailRows: Record<string, unknown>[], snapshot: unknown) {
    return {
      async query(text: string) {
        if (text.includes("financial_summary_detail")) {
          return { rows: detailRows.map((row) => ({ row })) };
        }
        if (text.includes("financial_summary_snapshot")) {
          return { rows: [{ snapshot }] };
        }
        return { rows: [] };
      },
      release() {},
    };
  }

  const baseSnapshot = {
    revenue: { total_cents: 0, row_count: 0, record_ids: [] },
    expenses: { total_cents: 15000, row_count: 2, record_ids: ["x1", "x2"] },
    fuel: { total_cents: 0, row_count: 0, record_ids: [] },
    maintenance: { total_cents: 0, row_count: 0, record_ids: [] },
    pipeline: { total_cents: 0, row_count: 0, record_ids: [], loads_without_rate_count: 0 },
    completed_missing_delivery_date: { count: 0, record_ids: [] },
    assigned_expenses: [],
    unassigned_expenses_in_period_cents: 0,
  };

  it("returns rows whose amounts sum exactly to the component total", async () => {
    const conn = detailConn(
      [
        { id: "x1", amount_cents: 10000 },
        { id: "x2", amount_cents: 5000 },
      ],
      baseSnapshot,
    );
    const detail = await readSummaryDetail(conn as never, "expenses", WINDOW);
    expect(detail.row_count).toBe(2);
    expect(detail.total_cents).toBe(15000);
    expect(detail.rows).toHaveLength(2);
  });

  it("refuses rows that do not reconcile with the aggregate", async () => {
    const conn = detailConn([{ id: "x1", amount_cents: 9999 }], baseSnapshot);
    await expect(readSummaryDetail(conn as never, "expenses", WINDOW)).rejects.toBeInstanceOf(
      SummaryUnverifiedError,
    );
  });
});
