// Reliability Unit C (design C.3 Rev 6): the F-033 snapshot
// transaction - the mechanism ChatGPT's acceptance review approved,
// with its seven binding conditions implemented here, in order:
//
// The summary (and the F-010 detail endpoint - condition 6, same
// runner) executes inside ONE dedicated database transaction whose
// FIRST statement is BEGIN ISOLATION LEVEL REPEATABLE READ, issued
// before any query exists (the isolation a snapshot needs can only be
// chosen there - a SET inside a function or RPC arrives too late).
// Every total is computed by SQL inside that snapshot; concurrent
// inserts, updates, deletes, and update-and-restore (ABA) writes are
// simply not in it, so a blended total is impossible by construction,
// not detected after the fact. The in-snapshot count assertion is
// retained as a completeness check: each component's row_count must
// equal the number of record IDs the snapshot returned, and any
// mismatch - or any failure in this machinery at all - surfaces as
// SummaryUnverifiedError, which the routes render as the visible
// "Summary couldn't be verified" state. Never a partial total.
//
// Tenant security (conditions 1, 2, 3, 5): the direct connection
// authenticates as a privileged role, so before any data query the
// transaction re-establishes the caller's context - SET LOCAL ROLE to
// the DATABASE role `authenticated` (never the application business
// role from the profile, which is a claims value, not a SET ROLE
// target), and the JWT claims GUC set, parameterized, from the
// VERIFIED AuthContext's userId only. Identity never comes from
// request parameters. Both settings are transaction-local (SET LOCAL
// / set_config(..., true)), so nothing survives on a pooled
// connection. RLS (F-003, untouched) then evaluates exactly as on the
// PostgREST path via current_company_id() <- auth.uid() <- claims.
//
// Lifecycle (condition 4): acquire one connection -> begin ->
// establish role + claims -> probe the isolation from inside the
// transaction (condition 7's proof obligation, C.7.3c: the endpoint
// verifies 'repeatable read' at runtime on the real code path) ->
// reads -> commit. Any failure rolls back and releases.

import type { AuthContext } from "@/services/auth";
import { getFinancialSummaryPool } from "@/services/db/financial-summary-pool";
import type { ComponentWindow, SummaryComponent } from "./filter";

/** A query ran but the snapshot could not be proven complete and
 * consistent - the ONLY honest answer is the unverified state. */
export class SummaryUnverifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryUnverifiedError";
  }
}

export interface SnapshotQueryable {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SnapshotConnection extends SnapshotQueryable {
  release(): void;
}

/** The seam the tests drive: production connects through the pool. */
export interface SnapshotConnectionProvider {
  connect(): Promise<SnapshotConnection>;
}

const poolProvider: SnapshotConnectionProvider = {
  async connect() {
    const pool = getFinancialSummaryPool();
    const client = await pool.connect();
    return client as unknown as SnapshotConnection;
  },
};

export async function runSummarySnapshot<T>(
  auth: AuthContext,
  work: (q: SnapshotQueryable) => Promise<T>,
  provider: SnapshotConnectionProvider = poolProvider,
): Promise<T> {
  let client: SnapshotConnection;
  try {
    client = await provider.connect();
  } catch {
    throw new SummaryUnverifiedError("The summary database connection could not be opened.");
  }

  try {
    // The FIRST statement of the transaction - before any query.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    // Database role, not the business role (condition 2).
    await client.query("SET LOCAL ROLE authenticated");
    // Claims from the verified server session only (condition 1),
    // parameterized and transaction-local (condition 3).
    const claims = JSON.stringify({ sub: auth.userId, role: "authenticated" });
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
    // Proof obligation (condition 7 / C.7.3c): read the isolation back
    // from inside this transaction on the real code path.
    const probe = await client.query(
      "SELECT current_setting('transaction_isolation') AS isolation",
    );
    if (probe.rows[0]?.isolation !== "repeatable read") {
      throw new SummaryUnverifiedError(
        "The summary transaction did not establish repeatable-read isolation.",
      );
    }

    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is released regardless; a failed rollback means
      // the connection is broken, not that state leaked anywhere.
    }
    if (err instanceof SummaryUnverifiedError) throw err;
    throw new SummaryUnverifiedError("The summary snapshot could not be completed.");
  } finally {
    client.release();
  }
}

export interface ComponentTotal {
  total_cents: number;
  row_count: number;
  record_ids: string[];
}

export interface SummarySnapshotData {
  components: Record<SummaryComponent, ComponentTotal>;
  pipeline: ComponentTotal & { loadsWithoutRateCount: number };
  completedMissingDeliveryDate: { count: number; record_ids: string[] };
  /** Every non-deleted expense carrying a load assignment (any date) -
   * the measures' direct-cost input. */
  assignedExpenses: { load_id: string; amount_cents: number; expense_date: string }[];
  unassignedExpensesInPeriodCents: number;
  /** Unit D (00068/00069): fuel assigned to a load, any date. Empty when 00069 is not applied - then all fuel reads as unassigned, as before. */
  assignedFuel: { load_id: string; amount_cents: number; purchased_at: string }[];
  /** The period's fuel assigned to no load. null = the snapshot predates 00069 (all period fuel is then treated as unassigned). */
  unassignedFuelInPeriodCents: number | null;
}

function asComponentTotal(raw: unknown, component: string): ComponentTotal {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(obj.record_ids) ? (obj.record_ids as string[]) : [];
  const total: ComponentTotal = {
    total_cents: Number(obj.total_cents ?? 0),
    row_count: Number(obj.row_count ?? 0),
    record_ids: ids,
  };
  // The in-snapshot completeness assertion: the COUNT taken inside
  // the snapshot must equal the IDs the snapshot actually returned.
  // A mismatch means a transfer was truncated - fail loudly.
  if (total.row_count !== total.record_ids.length) {
    throw new SummaryUnverifiedError(
      `The ${component} count did not match its record list inside the snapshot.`,
    );
  }
  return total;
}

/**
 * The summary read itself: ONE call to the read-logic function shipped
 * in migration 00044 (read logic only - it claims nothing about
 * isolation; the transaction above is what makes it a snapshot).
 */
export async function readSummarySnapshot(
  q: SnapshotQueryable,
  window: ComponentWindow,
): Promise<SummarySnapshotData> {
  const { rows } = await q.query(
    "SELECT public.financial_summary_snapshot($1::date, $2::date, $3::timestamptz, $4::timestamptz) AS snapshot",
    [window.from, window.to, window.fromTs, window.toTs],
  );
  const snapshot = rows[0]?.snapshot as Record<string, unknown> | undefined;
  if (!snapshot) {
    throw new SummaryUnverifiedError("The summary snapshot returned no data.");
  }

  const pipelineRaw = (snapshot.pipeline ?? {}) as Record<string, unknown>;
  const missingRaw = (snapshot.completed_missing_delivery_date ?? {}) as Record<
    string,
    unknown
  >;
  const missingIds = Array.isArray(missingRaw.record_ids)
    ? (missingRaw.record_ids as string[])
    : [];
  if (Number(missingRaw.count ?? 0) !== missingIds.length) {
    throw new SummaryUnverifiedError(
      "The completed-without-delivery-date count did not match its record list inside the snapshot.",
    );
  }

  return {
    components: {
      revenue: asComponentTotal(snapshot.revenue, "revenue"),
      expenses: asComponentTotal(snapshot.expenses, "expenses"),
      fuel: asComponentTotal(snapshot.fuel, "fuel"),
      maintenance: asComponentTotal(snapshot.maintenance, "maintenance"),
    },
    pipeline: {
      ...asComponentTotal(snapshot.pipeline, "pipeline"),
      loadsWithoutRateCount: Number(pipelineRaw.loads_without_rate_count ?? 0),
    },
    completedMissingDeliveryDate: {
      count: Number(missingRaw.count ?? 0),
      record_ids: missingIds,
    },
    assignedExpenses: Array.isArray(snapshot.assigned_expenses)
      ? (snapshot.assigned_expenses as SummarySnapshotData["assignedExpenses"])
      : [],
    unassignedExpensesInPeriodCents: Number(
      snapshot.unassigned_expenses_in_period_cents ?? 0,
    ),
    assignedFuel: Array.isArray(snapshot.assigned_fuel)
      ? (snapshot.assigned_fuel as SummarySnapshotData["assignedFuel"])
      : [],
    unassignedFuelInPeriodCents:
      snapshot.unassigned_fuel_in_period_cents === undefined || snapshot.unassigned_fuel_in_period_cents === null
        ? null
        : Number(snapshot.unassigned_fuel_in_period_cents),
  };
}

/** The amount column a detail row contributes to its component total. */
const COMPONENT_AMOUNT_FIELD: Record<SummaryComponent, string> = {
  revenue: "rate_cents",
  expenses: "amount_cents",
  fuel: "total_cost_cents",
  maintenance: "cost_cents",
};

export interface SummaryDetailData {
  rows: Record<string, unknown>[];
  total_cents: number;
  row_count: number;
}

/**
 * The F-010 detail read: the contributing rows AND the component
 * aggregate, both inside the caller's snapshot (same transaction as
 * the summary's - condition 6). The rows must reconcile with the
 * aggregate exactly; anything else is the unverified state.
 */
export async function readSummaryDetail(
  q: SnapshotQueryable,
  component: SummaryComponent,
  window: ComponentWindow,
): Promise<SummaryDetailData> {
  const { rows } = await q.query(
    "SELECT public.financial_summary_detail($1::text, $2::date, $3::date, $4::timestamptz, $5::timestamptz) AS row",
    [component, window.from, window.to, window.fromTs, window.toTs],
  );
  const detailRows = rows
    .map((r) => r.row as Record<string, unknown>)
    .filter((r) => r != null);

  const snapshot = await readSummarySnapshot(q, window);
  const aggregate = snapshot.components[component];
  const amountField = COMPONENT_AMOUNT_FIELD[component];
  const rowSum = detailRows.reduce(
    (total, row) => total + Number(row[amountField] ?? 0),
    0,
  );
  if (detailRows.length !== aggregate.row_count || rowSum !== aggregate.total_cents) {
    throw new SummaryUnverifiedError(
      "The detail rows did not reconcile with the summary total inside the snapshot.",
    );
  }
  return { rows: detailRows, total_cents: aggregate.total_cents, row_count: aggregate.row_count };
}
