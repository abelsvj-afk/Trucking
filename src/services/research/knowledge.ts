// Durable knowledge layer (docs/design/autonomous-research.md §3).
// The tick distills what the watchers saw - plus a daily snapshot of
// the company's OWN business from its records - into
// research_knowledge rows Abel can cite in chat with source + date.
// Everything here runs on the scoped job pool (Queryable), one
// company at a time, and every failure mode is a logged skip: a
// knowledge pass must never take the tick (or a briefing) down with
// it. Pre-00084 databases land in the catch and report "not applied"
// once per call, exactly like the store's graceful-absence pattern.

import { buildBusinessSnapshot } from "@/lib/business-snapshot";
import { watchTopicForSignal, type WatchTopic } from "@/lib/watch-topics";
import type { Queryable } from "@/services/ai/run-industry-briefing";
import type { PressureSignal } from "./watchers/types";

export interface KnowledgeRow {
  watch_topic: WatchTopic;
  title: string;
  content: string;
  source_title: string | null;
  source_url: string | null;
  observed_at: string;
}

const KNOWLEDGE_COLUMNS = "watch_topic, title, content, source_title, source_url, observed_at";

function isMissingTable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /research_knowledge/.test(message) && /does not exist|could not find|relation/i.test(message);
}

/**
 * Distills fresh signals into knowledge rows for one company.
 * Returns how many rows were actually stored (dedupe: one row per
 * signal per company - re-distilling a stored signal is a no-op).
 */
export async function distillSignalsToKnowledge(
  db: Queryable,
  companyId: string,
  signals: PressureSignal[],
): Promise<number> {
  let stored = 0;
  for (const signal of signals) {
    const topic = watchTopicForSignal(signal);
    if (!topic) continue;
    const item = signal.items[0];
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into research_knowledge (company_id, watch_topic, title, content, source_title, source_url, observed_at, dedupe_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (company_id, dedupe_key) do nothing
         returning id`,
        [
          companyId,
          topic,
          item?.title ?? signal.summary.slice(0, 120),
          signal.summary,
          item?.title ?? null,
          item?.url ?? null,
          signal.observedAt,
          signal.dedupeKey,
        ],
      );
      if (rows[0]) stored += 1;
    } catch (err) {
      if (isMissingTable(err)) {
        console.error("[research] knowledge distillation skipped - migration 00084 is not applied yet");
        return stored;
      }
      console.error("[research] knowledge distillation failed for one signal", err);
    }
  }
  return stored;
}

interface BusinessAggregateRow extends Record<string, unknown> {
  loads_in_window: number;
  loads_completed: number;
  total_miles: number;
  revenue_cents: number | null;
  revenue_loads: number;
}

interface ExpenseRow extends Record<string, unknown> {
  expense_cents: number;
}

interface LaneRow extends Record<string, unknown> {
  origin: string;
  destination: string;
  lane_count: number;
}

interface PayProfileRow extends Record<string, unknown> {
  rate_cents_per_mile: number;
  mile_basis: string | null;
}

export const BUSINESS_WINDOW_DAYS = 30;

/**
 * Builds (or refreshes) today's own-business knowledge row for one
 * company from its own records. One row per company per Eastern day
 * (dedupe key carries the day); a later tick the same day updates the
 * figures in place - the snapshot is a living read, not an archive.
 * Returns true when a row was written.
 */
export async function refreshBusinessKnowledge(
  db: Queryable,
  companyId: string,
  now: Date = new Date(),
): Promise<boolean> {
  let aggregate: BusinessAggregateRow | undefined;
  let expenseCents = 0;
  let lanes: LaneRow[] = [];
  let payProfile: PayProfileRow | undefined;
  try {
    const agg = await db.query<BusinessAggregateRow>(
      `select
         count(*)::int as loads_in_window,
         count(*) filter (where status = 'completed')::int as loads_completed,
         coalesce(sum(miles), 0)::float as total_miles,
         sum(rate_cents)::float as revenue_cents,
         count(rate_cents)::int as revenue_loads
       from loads
       where company_id = $1
         and deleted_at is null
         and pickup_date >= current_date - ($2 || ' days')::interval`,
      [companyId, String(BUSINESS_WINDOW_DAYS)],
    );
    aggregate = agg.rows[0];
    const exp = await db.query<ExpenseRow>(
      `select coalesce(sum(amount_cents), 0)::int as expense_cents
       from expenses
       where company_id = $1
         and deleted_at is null
         and expense_date >= current_date - ($2 || ' days')::interval`,
      [companyId, String(BUSINESS_WINDOW_DAYS)],
    );
    expenseCents = exp.rows[0]?.expense_cents ?? 0;
    const laneRows = await db.query<LaneRow>(
      `select origin, destination, count(*)::int as lane_count
       from loads
       where company_id = $1
         and deleted_at is null
         and pickup_date >= current_date - ($2 || ' days')::interval
       group by origin, destination
       order by lane_count desc, origin asc
       limit 3`,
      [companyId, String(BUSINESS_WINDOW_DAYS)],
    );
    lanes = laneRows.rows;
    const profile = await db.query<PayProfileRow>(
      `select rate_cents_per_mile, mile_basis
       from employer_pay_profiles
       where company_id = $1
         and deleted_at is null
         and effective_to is null
       order by effective_from desc
       limit 1`,
      [companyId],
    );
    payProfile = profile.rows[0];
  } catch (err) {
    // employer_pay_profiles is 00063 - an older database may lack it;
    // the snapshot then honestly says no profile is on file.
    if (!aggregate) {
      console.error("[research] business snapshot reads failed", err);
      return false;
    }
    payProfile = undefined;
  }
  if (!aggregate) return false;

  const snapshot = buildBusinessSnapshot({
    loadsInWindow: aggregate.loads_in_window,
    loadsCompleted: aggregate.loads_completed,
    totalMiles: aggregate.total_miles,
    revenueCents: aggregate.revenue_loads > 0 && aggregate.revenue_cents !== null ? Math.round(aggregate.revenue_cents) : null,
    expenseCents,
    topLanes: lanes.map((l) => `${l.origin} → ${l.destination} ×${l.lane_count}`),
    payProfile: payProfile
      ? { rateCentsPerMile: payProfile.rate_cents_per_mile, mileBasis: payProfile.mile_basis }
      : null,
    windowDays: BUSINESS_WINDOW_DAYS,
  });
  if (!snapshot) return false;

  const day = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  try {
    await db.query(
      `insert into research_knowledge (company_id, watch_topic, title, content, source_title, source_url, observed_at, dedupe_key)
       values ($1, 'own_business', $2, $3, 'His own records in the app', null, $4, $5)
       on conflict (company_id, dedupe_key) do update set
         title = excluded.title,
         content = excluded.content,
         observed_at = excluded.observed_at`,
      [companyId, snapshot.title, snapshot.content, now.toISOString(), `business_snapshot:${day}`],
    );
    return true;
  } catch (err) {
    if (isMissingTable(err)) {
      console.error("[research] business snapshot skipped - migration 00084 is not applied yet");
      return false;
    }
    throw err;
  }
}

/** The newest knowledge row per standing topic for one company (missing topic = absent key). */
export async function loadLatestKnowledgeByTopic(
  db: Queryable,
  companyId: string,
): Promise<Partial<Record<WatchTopic, KnowledgeRow>>> {
  const { rows } = await db.query<KnowledgeRow & Record<string, unknown>>(
    `select distinct on (watch_topic) ${KNOWLEDGE_COLUMNS}
     from research_knowledge
     where company_id = $1
     order by watch_topic, observed_at desc`,
    [companyId],
  );
  const out: Partial<Record<WatchTopic, KnowledgeRow>> = {};
  for (const row of rows) out[row.watch_topic] = row;
  return out;
}

/** Recent knowledge rows for one company, newest first - the chat tool's and page's read. */
export async function loadRecentKnowledge(
  db: Queryable,
  companyId: string,
  limit = 20,
): Promise<KnowledgeRow[]> {
  const { rows } = await db.query<KnowledgeRow & Record<string, unknown>>(
    `select ${KNOWLEDGE_COLUMNS}
     from research_knowledge
     where company_id = $1
     order by observed_at desc
     limit $2`,
    [companyId, limit],
  );
  return rows;
}
