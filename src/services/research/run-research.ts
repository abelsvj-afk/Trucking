// Deep Research Engine runner (docs/design/research-engine.md §§3-5).
// Mirrors run-industry-briefing.ts's shape deliberately: takes a
// Queryable (the scoped job pool) + an AiProvider, never throws, and
// lands EVERY outcome in research_runs - success, failure,
// insufficient_data, and the governance outcomes (skipped_cap,
// skipped_disabled) that must be visible rather than silent.
//
// Caps are enforced from SQL counts over research_runs (rolling 24h /
// 30d windows), never in-memory counters - Fly restarts this process
// freely, and a cap that resets on restart is not a cap.

import { generateResearchBriefing, type ResearchBriefingContext } from "@/services/ai/research-briefing";
import type { AiProvider } from "@/services/ai/provider";
import type { Queryable } from "@/services/ai/run-industry-briefing";
import type { TelegramNotifier } from "@/services/telegram/notify";
import { getResearchConfig, type ResearchConfig } from "./config";
import { capHeadroom, evaluateTriggers, type CompanyRunHistory, type RunDecision } from "./triggers";
import type { PressureSignal, ResearchSourceItem } from "./watchers/types";

export const DEEP_RESEARCH_CAPABILITY = "deep_research";

interface CompanyRow extends Record<string, unknown> {
  company_id: string;
}

interface SignalRow extends Record<string, unknown> {
  watcher_key: string;
  kind: string;
  topic: string;
  magnitude: number;
  summary: string;
  items: ResearchSourceItem[];
  data: Record<string, unknown>;
  dedupe_key: string;
  observed_at: string;
}

interface QueuedRunRow extends Record<string, unknown> {
  id: string;
  company_id: string;
  topic: string;
}

async function getEligibleCompanyIds(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<CompanyRow>(
    `select c.id as company_id
     from companies c
     join ai_capability_settings s
       on s.company_id = c.id and s.capability = $1
     where c.ai_globally_disabled = false
       and s.enabled = true`,
    [DEEP_RESEARCH_CAPABILITY],
  );
  return rows.map((row) => row.company_id);
}

const COUNTED_STATUSES = `('queued', 'running', 'success', 'failure', 'insufficient_data')`;

export async function loadRunHistory(db: Queryable, companyId: string): Promise<CompanyRunHistory> {
  const { rows } = await db.query<{
    last_baseline: string | null;
    runs_today: number;
    runs_month: number;
  } & Record<string, unknown>>(
    `select
       (select max(created_at) from research_runs
         where company_id = $1 and trigger_kind = 'scheduled' and status in ${COUNTED_STATUSES}) as last_baseline,
       (select count(*)::int from research_runs
         where company_id = $1 and status in ${COUNTED_STATUSES} and created_at > now() - interval '1 day') as runs_today,
       (select count(*)::int from research_runs
         where company_id = $1 and status in ${COUNTED_STATUSES} and created_at > now() - interval '30 days') as runs_month`,
    [companyId],
  );
  const row = rows[0];
  return {
    lastBaselineRunAt: row?.last_baseline ?? null,
    runsToday: row?.runs_today ?? 0,
    runsThisMonth: row?.runs_month ?? 0,
  };
}

async function gatherContext(
  db: Queryable,
  decision: RunDecision,
): Promise<ResearchBriefingContext> {
  const { rows } = await db.query<SignalRow>(
    `select watcher_key, kind, topic, magnitude, summary, items, data, dedupe_key, observed_at
     from research_signals
     where dedupe_key = any($1)
        or ($2 = 'industry' and observed_at > now() - interval '14 days')
        or (topic = $2 and observed_at > now() - interval '14 days')
     order by observed_at desc
     limit 30`,
    [decision.signalDedupeKeys, decision.topic],
  );

  const seenUrls = new Set<string>();
  const items: ResearchSourceItem[] = [];
  for (const row of rows) {
    for (const item of row.items ?? []) {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        items.push(item);
      }
    }
  }

  return {
    topic: decision.topic,
    triggerReason: decision.reason,
    items: items.slice(0, 25),
    signalSummaries: rows.map((row) => row.summary),
  };
}

/** Executes one already-decided run. `existingRunId` is set for queued manual runs (the row exists; claim it). */
export async function executeResearchRun(
  db: Queryable,
  provider: AiProvider,
  notifier: TelegramNotifier | null,
  companyId: string,
  decision: RunDecision,
  existingRunId?: string,
): Promise<void> {
  let runId = existingRunId;
  try {
    if (runId) {
      await db.query(
        `update research_runs set status = 'running', started_at = now() where id = $1`,
        [runId],
      );
    } else {
      const { rows } = await db.query<{ id: string }>(
        `insert into research_runs (company_id, trigger_kind, topic, trigger_detail, status, started_at)
         values ($1, $2, $3, $4, 'running', now())
         returning id`,
        [
          companyId,
          decision.kind,
          decision.topic,
          JSON.stringify({ reason: decision.reason, signal_dedupe_keys: decision.signalDedupeKeys }),
        ],
      );
      runId = rows[0]?.id;
    }
    if (!runId) throw new Error("Could not create the research run row.");

    const context = await gatherContext(db, decision);
    const output = await generateResearchBriefing(provider, context);

    if (output.status === "insufficient_data") {
      await db.query(
        `update research_runs set status = 'insufficient_data', finished_at = now(), error_message = $2 where id = $1`,
        [runId, output.reason],
      );
      return;
    }

    const sources = output.findings.map((f) => ({ title: f.source_title, url: f.source_url }));
    const { rows } = await db.query<{ id: string }>(
      `insert into research_briefings
         (company_id, run_id, topic, title, headline, findings, what_changed, counter_move, takeaway, unverified, sources, confidence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning id`,
      [
        companyId,
        runId,
        decision.topic,
        output.title,
        output.headline,
        JSON.stringify(output.findings),
        output.what_changed,
        output.counter_move,
        output.takeaway,
        JSON.stringify(output.unverified),
        JSON.stringify(sources),
        output.confidence,
      ],
    );
    const briefingId = rows[0]?.id;

    await db.query(
      `update research_runs set status = 'success', finished_at = now(), briefing_id = $2 where id = $1`,
      [runId, briefingId],
    );

    if (notifier && briefingId) {
      const sent = await notifier.notifyOwner(
        `New research briefing: ${output.title}\n${output.headline}\nTakeaway: ${output.takeaway}\nOpen the app → More → Research for the full briefing.`,
      );
      if (sent) {
        await db.query(`update research_briefings set telegram_notified_at = now() where id = $1`, [briefingId]);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error during research run.";
    console.error("[research] run failed", err);
    if (runId) {
      await db.query(
        `update research_runs set status = 'failure', finished_at = now(), error_message = $2 where id = $1`,
        [runId, message],
      );
    }
  }
}

async function logSkippedRun(
  db: Queryable,
  companyId: string,
  decision: RunDecision,
  status: "skipped_cap" | "skipped_disabled",
  detail: string,
  existingRunId?: string,
): Promise<void> {
  if (existingRunId) {
    await db.query(
      `update research_runs set status = $2, finished_at = now(), error_message = $3 where id = $1`,
      [existingRunId, status, detail],
    );
    return;
  }
  await db.query(
    `insert into research_runs (company_id, trigger_kind, topic, trigger_detail, status, finished_at, error_message)
     values ($1, $2, $3, $4, $5, now(), $6)`,
    [
      companyId,
      decision.kind,
      decision.topic,
      JSON.stringify({ reason: decision.reason, signal_dedupe_keys: decision.signalDedupeKeys }),
      status,
      detail,
    ],
  );
}

export interface CompanyTickSummary {
  executed: number;
  skippedCap: number;
  skippedDisabled: number;
}

/**
 * One company's tick: queued manual runs first (the owner explicitly
 * asked), then trigger decisions in priority order - each checked
 * against the remaining cap headroom, each outcome logged.
 */
export async function runResearchForCompany(
  db: Queryable,
  provider: AiProvider,
  notifier: TelegramNotifier | null,
  companyId: string,
  freshSignals: PressureSignal[],
  config: ResearchConfig = getResearchConfig(),
  now: Date = new Date(),
): Promise<CompanyTickSummary> {
  const summary: CompanyTickSummary = { executed: 0, skippedCap: 0, skippedDisabled: 0 };
  const history = await loadRunHistory(db, companyId);

  const { rows: queued } = await db.query<QueuedRunRow>(
    `select id, company_id, topic from research_runs
     where company_id = $1 and trigger_kind = 'manual' and status = 'queued'
     order by created_at asc`,
    [companyId],
  );

  const queue: Array<{ decision: RunDecision; runId?: string }> = [
    ...queued.map((row) => ({
      decision: {
        kind: "manual" as const,
        topic: row.topic,
        reason: "Owner requested this research from the app (\"research this now\").",
        signalDedupeKeys: [],
      },
      runId: row.id,
    })),
    ...evaluateTriggers({ now, history, freshSignals, config }).map((decision) => ({ decision })),
  ];

  for (const item of queue) {
    if (capHeadroom(history, config) <= 0) {
      await logSkippedRun(
        db,
        companyId,
        item.decision,
        "skipped_cap",
        `Run cap reached (${history.runsToday}/${config.maxRunsPerDay} today, ${history.runsThisMonth}/${config.maxRunsPerMonth} this month).`,
        item.runId,
      );
      summary.skippedCap += 1;
      continue;
    }
    await executeResearchRun(db, provider, notifier, companyId, item.decision, item.runId);
    summary.executed += 1;
    history.runsToday += 1;
    history.runsThisMonth += 1;
    if (item.decision.kind === "scheduled") history.lastBaselineRunAt = now.toISOString();
  }

  return summary;
}

/**
 * The engine tick for every company. Kill-switch discipline: only
 * companies with deep_research enabled (and not globally disabled) get
 * runs; a queued manual run belonging to a disabled company is closed
 * out as skipped_disabled so the owner's request never hangs in limbo.
 */
export async function runResearchJob(
  db: Queryable,
  provider: AiProvider,
  notifier: TelegramNotifier | null,
  freshSignals: PressureSignal[],
  config: ResearchConfig = getResearchConfig(),
): Promise<void> {
  const eligible = new Set(await getEligibleCompanyIds(db));

  const { rows: queued } = await db.query<QueuedRunRow>(
    `select id, company_id, topic from research_runs where trigger_kind = 'manual' and status = 'queued'`,
  );
  for (const row of queued) {
    if (!eligible.has(row.company_id)) {
      await logSkippedRun(
        db,
        row.company_id,
        { kind: "manual", topic: row.topic, reason: "Owner-requested run.", signalDedupeKeys: [] },
        "skipped_disabled",
        "Deep research capability is off for this company (Settings) - the queued request was not run.",
        row.id,
      );
    }
  }

  for (const companyId of eligible) {
    await runResearchForCompany(db, provider, notifier, companyId, freshSignals, config);
  }
}
