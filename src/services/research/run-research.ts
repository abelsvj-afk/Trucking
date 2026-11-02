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
import { loadCorridorStates } from "./corridor";
import {
  classifyDelivery,
  deliveryDecision,
  formatBriefingMessage,
  formatDigestMessage,
  type DeliveryClass,
} from "./delivery";
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

export async function getEligibleCompanyIds(db: Queryable): Promise<string[]> {
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
    last_baseline_success?: string | null;
    runs_today: number;
    runs_month: number;
    baseline_today?: number;
    baseline_month?: number;
  } & Record<string, unknown>>(
    `select
       (select max(created_at) from research_runs
         where company_id = $1 and trigger_kind = 'scheduled' and status in ${COUNTED_STATUSES}) as last_baseline,
       (select max(created_at) from research_runs
         where company_id = $1 and trigger_kind = 'scheduled' and status = 'success') as last_baseline_success,
       (select count(*)::int from research_runs
         where company_id = $1 and trigger_kind != 'scheduled' and status in ${COUNTED_STATUSES} and created_at > now() - interval '1 day') as runs_today,
       (select count(*)::int from research_runs
         where company_id = $1 and trigger_kind != 'scheduled' and status in ${COUNTED_STATUSES} and created_at > now() - interval '30 days') as runs_month,
       (select count(*)::int from research_runs
         where company_id = $1 and trigger_kind = 'scheduled' and status in ${COUNTED_STATUSES} and created_at > now() - interval '1 day') as baseline_today,
       (select count(*)::int from research_runs
         where company_id = $1 and trigger_kind = 'scheduled' and status in ${COUNTED_STATUSES} and created_at > now() - interval '30 days') as baseline_month`,
    [companyId],
  );
  const row = rows[0];

  const lastPressureRunByTopic: Record<string, string> = {};
  try {
    const { rows: pressureRows } = await db.query<{ topic: string; last_at: string } & Record<string, unknown>>(
      `select topic, max(created_at) as last_at from research_runs
       where company_id = $1 and trigger_kind = 'pressure' and status in ${COUNTED_STATUSES}
       group by topic`,
      [companyId],
    );
    for (const pressureRow of pressureRows) {
      if (typeof pressureRow.topic === "string" && typeof pressureRow.last_at === "string") {
        lastPressureRunByTopic[pressureRow.topic] = pressureRow.last_at;
      }
    }
  } catch (err) {
    console.error("[research] could not load pressure cooldown state", err);
  }

  return {
    lastBaselineRunAt: row?.last_baseline ?? null,
    // Distinguish "column absent" (older test doubles - fall back to
    // attempt-based due-ness) from "column null" (no success yet -
    // the success-based floor applies). Real rows always carry it.
    lastBaselineSuccessAt: row && "last_baseline_success" in row ? (row.last_baseline_success ?? null) : undefined,
    runsToday: row?.runs_today ?? 0,
    runsThisMonth: row?.runs_month ?? 0,
    baselineRunsToday: row?.baseline_today ?? 0,
    baselineRunsThisMonth: row?.baseline_month ?? 0,
    lastPressureRunByTopic,
  };
}

/**
 * Stored pressure that was never consumed by an executed run (D-2):
 * signals whose dedupe keys appear in no non-skipped run's
 * trigger_detail. Re-evaluated every tick, so pressure that landed on
 * a capped day fires later instead of being silently dropped.
 */
export async function loadUnconsumedSignals(db: Queryable, companyId: string): Promise<PressureSignal[]> {
  const { rows } = await db.query<SignalRow>(
    `select s.watcher_key, s.kind, s.topic, s.magnitude, s.summary, s.items, s.data, s.dedupe_key, s.observed_at
     from research_signals s
     where (s.company_id is null or s.company_id = $1)
       and s.observed_at > now() - interval '7 days'
       and not exists (
         select 1 from research_runs r
         where r.status not in ('skipped_cap', 'skipped_disabled')
           and r.trigger_detail -> 'signal_dedupe_keys' ? s.dedupe_key
       )
     order by s.observed_at desc
     limit 50`,
    [companyId],
  );
  return rows.map((row) => ({
    watcherKey: row.watcher_key,
    kind: row.kind,
    topic: row.topic,
    magnitude: row.magnitude,
    summary: row.summary,
    items: row.items ?? [],
    data: row.data ?? {},
    dedupeKey: row.dedupe_key,
    observedAt: row.observed_at,
  }));
}

async function loadLatestDutyStatus(db: Queryable, companyId: string): Promise<string | null> {
  const { rows } = await db.query<{ duty_status: string } & Record<string, unknown>>(
    `select duty_status from duty_logs
     where company_id = $1 and deleted_at is null
     order by started_at desc
     limit 1`,
    [companyId],
  );
  return rows[0]?.duty_status ?? null;
}

async function loadDecisionSignals(db: Queryable, dedupeKeys: string[]): Promise<PressureSignal[]> {
  if (dedupeKeys.length === 0) return [];
  const { rows } = await db.query<SignalRow>(
    `select watcher_key, kind, topic, magnitude, summary, items, data, dedupe_key, observed_at
     from research_signals where dedupe_key = any($1)`,
    [dedupeKeys],
  );
  return rows.map((row) => ({
    watcherKey: row.watcher_key,
    kind: row.kind,
    topic: row.topic,
    magnitude: row.magnitude,
    summary: row.summary,
    items: row.items ?? [],
    data: row.data ?? {},
    dedupeKey: row.dedupe_key,
    observedAt: row.observed_at,
  }));
}

async function gatherContext(
  db: Queryable,
  decision: RunDecision,
  corridorStates: string[] = [],
): Promise<ResearchBriefingContext> {
  const gather = async (windowDays: number): Promise<SignalRow[]> => {
    const { rows } = await db.query<SignalRow>(
      `select watcher_key, kind, topic, magnitude, summary, items, data, dedupe_key, observed_at
       from research_signals
       where dedupe_key = any($1)
          or ($2 = 'industry' and observed_at > now() - ($3 || ' days')::interval)
          or (topic = $2 and observed_at > now() - ($3 || ' days')::interval)
       order by observed_at desc
       limit 30`,
      [decision.signalDedupeKeys, decision.topic, String(windowDays)],
    );
    return rows;
  };

  const dedupeItems = (rows: SignalRow[]): ResearchSourceItem[] => {
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
    return items;
  };

  let rows = await gather(14);
  // Floor fallback (D-2): a due baseline that finds too little citable
  // evidence in 14 days widens to 30 before conceding insufficient_data.
  if (decision.kind === "scheduled" && dedupeItems(rows).length < 5) {
    rows = await gather(30);
  }

  const decisionKeys = new Set(decision.signalDedupeKeys);
  const summaries = rows.map((row) =>
    decision.kind === "pressure" && !decisionKeys.has(row.dedupe_key)
      ? `Weak signal (context only, did not trigger on its own): ${row.summary}`
      : row.summary,
  );

  // Corridor framing (D-5): when a gathered signal touches the states
  // his current run crosses, tell the briefing so the counter-move is
  // about HIS run, not the industry in general.
  const touchesCorridor = rows.some((row) => {
    const states = (row.data as Record<string, unknown>)?.states;
    return Array.isArray(states) && states.some((s) => typeof s === "string" && corridorStates.includes(s));
  });
  if (touchesCorridor) {
    summaries.unshift(
      `Corridor: his current run touches ${corridorStates.join(", ")} - frame the counter-move for that run specifically.`,
    );
  }

  return {
    topic: decision.topic,
    triggerReason: decision.reason,
    items: dedupeItems(rows).slice(0, 25),
    signalSummaries: summaries,
  };
}

export type ResearchRunOutcome = "success" | "failure" | "insufficient_data";

/** Executes one already-decided run. `existingRunId` is set for queued manual runs (the row exists; claim it). */
export async function executeResearchRun(
  db: Queryable,
  provider: AiProvider,
  notifier: TelegramNotifier | null,
  companyId: string,
  decision: RunDecision,
  existingRunId?: string,
  config: ResearchConfig = getResearchConfig(),
  now: Date = new Date(),
  corridorStates: string[] = [],
): Promise<ResearchRunOutcome> {
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

    const context = await gatherContext(db, decision, corridorStates);
    const output = await generateResearchBriefing(provider, context);

    if (output.status === "insufficient_data") {
      await db.query(
        `update research_runs set status = 'insufficient_data', finished_at = now(), error_message = $2 where id = $1`,
        [runId, output.reason],
      );
      return "insufficient_data";
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

    if (briefingId) {
      await deliverBriefing(db, notifier, companyId, briefingId, decision, output, config, now, corridorStates);
    }
    return "success";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error during research run.";
    console.error("[research] run failed", err);
    if (runId) {
      await db.query(
        `update research_runs set status = 'failure', finished_at = now(), error_message = $2 where id = $1`,
        [runId, message],
      );
    }
    return "failure";
  }
}

/**
 * Delivery timing (D-6): classify the briefing from its producing
 * signals, then either buzz now or record the hold (quiet hours /
 * driving). The briefing is in the app either way; only the buzz
 * waits. Delivery bookkeeping never fails the run.
 */
async function deliverBriefing(
  db: Queryable,
  notifier: TelegramNotifier | null,
  companyId: string,
  briefingId: string,
  decision: RunDecision,
  output: { title: string; headline: string; counter_move: string; takeaway: string },
  config: ResearchConfig,
  now: Date,
  corridorStates: string[],
): Promise<void> {
  try {
    const signals = await loadDecisionSignals(db, decision.signalDedupeKeys);
    const deliveryClass: DeliveryClass = classifyDelivery({ signals, corridorStates });
    const dutyStatus = await loadLatestDutyStatus(db, companyId);
    const verdict = deliveryDecision({ now, deliveryClass, latestDutyStatus: dutyStatus, config });

    if (verdict.sendNow && notifier) {
      const sent = await notifier.notifyOwner(
        formatBriefingMessage({
          topic: decision.topic,
          title: output.title,
          headline: output.headline,
          counterMove: output.counter_move,
          takeaway: output.takeaway,
        }),
      );
      if (sent) {
        await db.query(
          `update research_briefings set telegram_notified_at = now(), delivery_class = $2 where id = $1`,
          [briefingId, deliveryClass],
        );
        return;
      }
    }
    await db.query(
      `update research_briefings set delivery_class = $2, delivery_held_until = $3 where id = $1`,
      [briefingId, deliveryClass, verdict.sendNow ? null : verdict.heldUntil?.toISOString() ?? null],
    );
  } catch (err) {
    console.error("[research] briefing delivery bookkeeping failed", err);
  }
}

interface HeldBriefingRow extends Record<string, unknown> {
  id: string;
  topic: string;
  title: string;
  headline: string;
  counter_move: string;
  takeaway: string;
  delivery_class: string;
}

/** The stored delivery_class, read defensively - anything unrecognized is routine (the column's own default). */
function toDeliveryClass(value: string): DeliveryClass {
  return value === "urgent" || value === "trip" ? value : "routine";
}

/**
 * Flush briefings whose delivery hold has expired (D-6 digest): one
 * message for the batch, each briefing marked notified only when
 * Telegram accepted the send. Runs at the top of a company's tick.
 *
 * CD-5: expiry of the hold is not by itself permission to buzz. A
 * driving hold's 4h cap can expire INSIDE the quiet window (created
 * 18:00 while driving -> held to 22:00, squarely in 21:00-06:00), so
 * every candidate re-runs the delivery decision at flush time:
 * urgent sends immediately as always; a non-urgent briefing caught
 * by quiet hours is re-held to the end of the window instead of
 * sent, with the recomputed reason logged (hold reasons are not
 * persisted - the schema stores class + held_until only, the same
 * treatment creation gives them).
 */
export async function flushHeldDeliveries(
  db: Queryable,
  notifier: TelegramNotifier | null,
  companyId: string,
  now: Date = new Date(),
  config: ResearchConfig = getResearchConfig(),
): Promise<number> {
  if (!notifier) return 0;
  try {
    const { rows } = await db.query<HeldBriefingRow>(
      `select id, topic, title, headline, counter_move, takeaway, delivery_class
       from research_briefings
       where company_id = $1 and telegram_notified_at is null
         and delivery_held_until is not null and delivery_held_until <= $2
       order by created_at asc
       limit 10`,
      [companyId, now.toISOString()],
    );
    if (rows.length === 0) return 0;

    const sendable: HeldBriefingRow[] = [];
    for (const row of rows) {
      const deliveryClass = toDeliveryClass(row.delivery_class);
      const verdict = deliveryDecision({ now, deliveryClass, latestDutyStatus: null, config });
      if (verdict.sendNow) {
        sendable.push(row);
        continue;
      }
      await db.query(
        `update research_briefings set delivery_held_until = $2 where id = $1`,
        [row.id, verdict.heldUntil?.toISOString() ?? null],
      );
      console.info(
        `[research] delivery flush re-held briefing ${row.id} (${deliveryClass}) until ${verdict.heldUntil?.toISOString()}: ${verdict.reason ?? "held"}`,
      );
    }
    if (sendable.length === 0) return 0;

    const sent = await notifier.notifyOwner(
      formatDigestMessage(
        sendable.map((row) => ({
          topic: row.topic,
          title: row.title,
          headline: row.headline,
          counterMove: row.counter_move,
          takeaway: row.takeaway,
        })),
      ),
    );
    if (!sent) return 0;
    for (const row of sendable) {
      await db.query(`update research_briefings set telegram_notified_at = now() where id = $1`, [row.id]);
    }
    return sendable.length;
  } catch (err) {
    // Pre-migration databases lack the delivery columns - degrade to
    // "nothing held" rather than failing the tick.
    console.error("[research] held-delivery flush failed", err);
    return 0;
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
  if (status === "skipped_cap") {
    // Coalesce (D-2): one skipped_cap row per company/topic/kind per
    // Eastern day, refreshed in place - the run log is the owner's
    // health signal and must not fill with hourly duplicates while a
    // cap drains.
    const { rows: existing } = await db.query<{ id: string } & Record<string, unknown>>(
      `select id from research_runs
       where company_id = $1 and topic = $2 and trigger_kind = $3 and status = 'skipped_cap'
         and created_at >= (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York')
       order by created_at desc
       limit 1`,
      [companyId, decision.topic, decision.kind],
    );
    if (existing[0]) {
      await db.query(
        `update research_runs set finished_at = now(), error_message = $2 where id = $1`,
        [existing[0].id, detail],
      );
      return;
    }
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

  // Held Telegram deliveries flush first - they cost no AI spend and
  // the owner is waiting on them (D-6).
  await flushHeldDeliveries(db, notifier, companyId, now, config);

  // Corridor + stored-signal re-evaluation (D-5/D-2). Both degrade to
  // empty on any failure (e.g. pre-migration database) - the tick must
  // not die because an upgrade table isn't there yet.
  let corridorStates: string[] = [];
  try {
    corridorStates = await loadCorridorStates(db, companyId);
  } catch (err) {
    console.error("[research] corridor load failed", err);
  }
  let storedSignals: PressureSignal[] = [];
  try {
    storedSignals = await loadUnconsumedSignals(db, companyId);
  } catch (err) {
    console.error("[research] stored-signal load failed", err);
  }

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
    ...evaluateTriggers({ now, history, freshSignals, storedSignals, corridorStates, config }).map((decision) => ({
      decision,
    })),
  ];

  for (const item of queue) {
    if (capHeadroom(history, config, item.decision.kind) <= 0) {
      await logSkippedRun(
        db,
        companyId,
        item.decision,
        "skipped_cap",
        item.decision.kind === "scheduled"
          ? `Baseline reserve reached (${history.baselineRunsThisMonth ?? 0}/${config.baselineReservePerMonth} reserved baseline runs this month).`
          : `Run cap reached (${history.runsToday}/${config.maxRunsPerDay} today, ${history.runsThisMonth}/${config.maxRunsPerMonth} this month).`,
        item.runId,
      );
      summary.skippedCap += 1;
      continue;
    }
    const outcome = await executeResearchRun(
      db,
      provider,
      notifier,
      companyId,
      item.decision,
      item.runId,
      config,
      now,
      corridorStates,
    );
    summary.executed += 1;
    if (item.decision.kind === "scheduled") {
      history.baselineRunsToday = (history.baselineRunsToday ?? 0) + 1;
      history.baselineRunsThisMonth = (history.baselineRunsThisMonth ?? 0) + 1;
      history.lastBaselineRunAt = now.toISOString();
      if (outcome === "success") history.lastBaselineSuccessAt = now.toISOString();
    } else {
      history.runsToday += 1;
      history.runsThisMonth += 1;
      if (item.decision.kind === "pressure") {
        history.lastPressureRunByTopic = {
          ...(history.lastPressureRunByTopic ?? {}),
          [item.decision.topic]: now.toISOString(),
        };
      }
    }
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
