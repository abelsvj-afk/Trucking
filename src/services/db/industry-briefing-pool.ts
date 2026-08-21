// Task 4.4 (TASKS.md). The industry-intelligence job's actual database
// connection - a direct `pg` connection using its own scoped least-
// privilege Postgres role (INDUSTRY_BRIEFING_DB_URL, docs/automation.md),
// not the Supabase JS client (that path is built around the anon key +
// RLS-via-user-session model, which doesn't fit an unattended job with no
// session). Lazily constructed and reused - this job runs on a long
// interval, not per-request, so a fresh Pool per run would be wasteful.

import { Pool } from "pg";

let pool: Pool | null = null;

export function getIndustryBriefingPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.INDUSTRY_BRIEFING_DB_URL;
  if (!connectionString) {
    throw new Error("INDUSTRY_BRIEFING_DB_URL is not configured.");
  }

  pool = new Pool({ connectionString });
  return pool;
}
