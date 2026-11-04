// Reliability Unit C (design C.3 Rev 6): the financial summary's
// dedicated DIRECT Postgres connection - the path the snapshot
// transaction runs over. Same construction as the industry-briefing
// pool, but a different, separately-scoped secret.
//
// The connection string is a SERVER-ONLY secret: FINANCIAL_SUMMARY_DB_URL.
// The owner sets it on Fly at deploy time (recorded here by NAME only -
// the value never appears in code or chat). It authenticates as the
// app's privileged direct role, which is exactly why every transaction
// on this pool immediately re-establishes the caller's RLS context
// (SET LOCAL ROLE authenticated + the verified session's JWT claims -
// see services/financial-summary/snapshot.ts): without that step the
// reads would bypass row-level security, which the design names a
// defect. Nothing else in the app uses this pool; ordinary requests
// keep using the Supabase client at READ COMMITTED (C.7.3c).

import { Pool } from "pg";

let pool: Pool | null = null;

export function getFinancialSummaryPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.FINANCIAL_SUMMARY_DB_URL;
  if (!connectionString) {
    throw new Error("FINANCIAL_SUMMARY_DB_URL is not configured.");
  }

  pool = new Pool({ connectionString });
  return pool;
}
