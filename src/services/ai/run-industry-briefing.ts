// Task 4.3/4.6/4.7 (TASKS.md). Orchestrates one full run of the
// industry-intelligence job: check kill switches -> gather sources ->
// generate a briefing -> persist the result, per docs/automation.md.
//
// Uses the job's own scoped Postgres credential (INDUSTRY_BRIEFING_DB_URL,
// docs/automation.md task 4.4) via `pg` directly - NOT the Supabase JS
// client/anon key (there's no user session for an unattended job to run
// under) and NOT SUPABASE_SERVICE_ROLE_KEY (bypasses RLS entirely, the
// real gap found and fixed while designing this - see .env.example).
//
// Takes a `Queryable` rather than constructing its own `pg.Pool`, same
// "pass the client in" pattern services/db/crud.ts already uses - keeps
// this testable without a real database connection.

import { gatherIndustrySources, SourceUnreachableError } from "@/services/integrations";
import { generateIndustryBriefing } from "./industry-briefing";
import type { AiProvider } from "./provider";

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export const INDUSTRY_INTELLIGENCE_CAPABILITY = "industry_intelligence";

// docs/automation.md's default: no more than once daily. Kept here (not
// just in the scheduler) since this is the actual enforcement point -
// see getEligibleCompanies below for why.
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface EligibleCompany extends Record<string, unknown> {
  company_id: string;
}

// Both kill switches off and capability enabled AND (no prior run yet, or
// the configured interval has actually elapsed since the last one) -
// checked against the database, not in-memory timer state, since Fly.io
// can restart the process far more often than once a day (docs/runtime.md).
// This is the real enforcement of "no more than once daily," not the
// scheduler's own check-in cadence.
async function getEligibleCompanies(db: Queryable, intervalMs: number): Promise<string[]> {
  const { rows } = await db.query<EligibleCompany>(
    `select c.id as company_id
     from companies c
     join ai_capability_settings s
       on s.company_id = c.id and s.capability = $1
     where c.ai_globally_disabled = false
       and s.enabled = true
       and not exists (
         select 1 from industry_briefing_runs r
         where r.company_id = c.id
           and r.started_at > now() - ($2 || ' milliseconds')::interval
       )`,
    [INDUSTRY_INTELLIGENCE_CAPABILITY, String(intervalMs)],
  );
  return rows.map((row) => row.company_id);
}

/** One company's run. Never throws - every outcome (success, insufficient data, failure) is logged to industry_briefing_runs and this returns normally either way, per docs/automation.md's "no automatic immediate retry." */
export async function runIndustryBriefingForCompany(
  db: Queryable,
  provider: AiProvider,
  companyId: string,
): Promise<void> {
  const startedAt = new Date();

  try {
    const sources = await gatherIndustrySources();
    const output = await generateIndustryBriefing(provider, sources);

    if (output.status === "insufficient_data") {
      await db.query(
        `insert into industry_briefing_runs (company_id, started_at, finished_at, status, error_message)
         values ($1, $2, now(), 'insufficient_data', $3)`,
        [companyId, startedAt, output.reason],
      );
      return;
    }

    const { rows } = await db.query<{ id: string }>(
      `insert into industry_briefings (company_id, summary, reasoning, confidence, based_on, generated_at)
       values ($1, $2, $3, $4, $5, now())
       returning id`,
      [companyId, output.summary, output.reasoning, output.confidence, JSON.stringify(output.based_on)],
    );
    const briefingId = rows[0]?.id;

    await db.query(
      `insert into industry_briefing_runs (company_id, started_at, finished_at, status, briefing_id)
       values ($1, $2, now(), 'success', $3)`,
      [companyId, startedAt, briefingId],
    );
  } catch (err) {
    const message =
      err instanceof SourceUnreachableError || err instanceof Error
        ? err.message
        : "Unknown error during industry-briefing run.";
    // Logged server-side only - never leaked raw to any UI, per CLAUDE.md's
    // centralized error handling. A single failure is routine and silent
    // per docs/automation.md; escalation is computed by counting these
    // rows (task 4.7), not raised here.
    console.error("[industry-briefing] run failed", err);
    await db.query(
      `insert into industry_briefing_runs (company_id, started_at, finished_at, status, error_message)
       values ($1, $2, now(), 'failure', $3)`,
      [companyId, startedAt, message],
    );
  }
}

/**
 * Runs every company currently eligible: both kill switches off,
 * capability enabled, and (per docs/automation.md's rate limit) not run
 * more recently than `intervalMs` ago. Called by the scheduler's
 * check-in tick, and by the manual-trigger debug route (which passes
 * intervalMs=0 to bypass the rate-limit gate - deliberate, since forcing
 * a run for debugging is the whole point of that route).
 */
export async function runIndustryBriefingJob(
  db: Queryable,
  provider: AiProvider,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<void> {
  const companyIds = await getEligibleCompanies(db, intervalMs);
  for (const companyId of companyIds) {
    await runIndustryBriefingForCompany(db, provider, companyId);
  }
}
