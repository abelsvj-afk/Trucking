// Deep Research Engine watchdog (2026-11-02 design, D-1.3 + D-8).
// Silence must never look like health: this module runs inside each
// tick and checks the engine against itself - heartbeat staleness,
// watchers stuck in error, the EIA key missing, and the floor itself
// (no successful briefing in floorAlertDays even when ticks are
// green). Issues alert the owner on Telegram, throttled to one alert
// per issue per 24h via research_health_alerts, and a recovered issue
// earns one "recovered" message so he learns to trust the silence.
// The watchdog never throws into the tick.

import type { Queryable } from "@/services/ai/run-industry-briefing";
import type { TelegramNotifier } from "@/services/telegram/notify";
import type { ResearchConfig } from "./config";
import { getEligibleCompanyIds } from "./run-research";

export interface HealthIssue {
  key: string;
  companyId: string | null;
  detail: string;
}

interface AlertRow extends Record<string, unknown> {
  issue_key: string;
  last_alerted_at: string | null;
  active: boolean;
}

const HOUR_MS = 60 * 60 * 1000;

export async function detectHealthIssues(
  db: Queryable,
  config: ResearchConfig,
  now: Date,
): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];

  const { rows: heartbeat } = await db.query<{ last_tick_at: string | null } & Record<string, unknown>>(
    `select last_tick_at from research_runner_heartbeat where id = 1`,
  );
  const lastTickAt = heartbeat[0]?.last_tick_at ?? null;
  if (!lastTickAt) {
    issues.push({
      key: "runner_never_ticked",
      companyId: null,
      detail: "The research runner has never recorded a tick - the engine has no proof of life yet.",
    });
  } else if (now.getTime() - Date.parse(lastTickAt) > config.heartbeatStaleHours * HOUR_MS) {
    issues.push({
      key: "runner_stale",
      companyId: null,
      detail: `The research runner last ticked at ${lastTickAt} - more than ${config.heartbeatStaleHours}h ago. Watchers are not polling and no briefings can be produced until it runs again.`,
    });
  }

  const { rows: watchers } = await db.query<
    { watcher_key: string; last_status: string; last_error: string | null; updated_at: string } & Record<string, unknown>
  >(`select watcher_key, last_status, last_error, updated_at from research_watcher_state`);
  for (const watcher of watchers) {
    if (watcher.last_status === "error" && now.getTime() - Date.parse(watcher.updated_at) > config.watcherErrorAlertHours * HOUR_MS) {
      issues.push({
        key: `watcher_error:${watcher.watcher_key}`,
        companyId: null,
        detail: `Watcher "${watcher.watcher_key}" has been in error for over ${config.watcherErrorAlertHours}h: ${watcher.last_error ?? "unknown error"}`,
      });
    }
    if (watcher.watcher_key === "eia_diesel" && watcher.last_status === "skipped") {
      issues.push({
        key: "eia_key_missing",
        companyId: null,
        detail: "The diesel watcher is skipping every poll - EIA_API_KEY appears unset, so diesel pressure is inferred from news only. Free key registration at eia.gov (owner setup item).",
      });
    }
  }

  const eligible = await getEligibleCompanyIds(db);
  for (const companyId of eligible) {
    const { rows } = await db.query<{ last_success: string | null } & Record<string, unknown>>(
      `select max(created_at) as last_success from research_runs where company_id = $1 and status = 'success'`,
      [companyId],
    );
    const lastSuccess = rows[0]?.last_success ?? null;
    if (!lastSuccess || now.getTime() - Date.parse(lastSuccess) > config.floorAlertDays * 24 * HOUR_MS) {
      issues.push({
        key: `floor:${companyId}`,
        companyId,
        detail: lastSuccess
          ? `No successful research briefing in over ${config.floorAlertDays} days (last: ${lastSuccess}) - the floor is not being met even if the runner ticks.`
          : `No successful research briefing has ever been recorded - the floor has never been met.`,
      });
    }
  }

  return issues;
}

export interface HealthSummary {
  alertsSent: string[];
  recovered: string[];
  /**
   * Set when health could not be evaluated the normal way because the
   * engine died before the watchdog could run (CD-7 - e.g. the job
   * database is not configured). An explicit failure state, so a
   * broken engine never presents as a silent `health: null` again.
   */
  failure?: string;
}

export const RUNNER_CONFIG_MISSING_ISSUE = "runner_config_missing";

const CONFIG_ALERT_THROTTLE_MS = 24 * HOUR_MS;
let lastConfigAlertAtMs: number | null = null;

/**
 * The watchdog's last resort (CD-7): the failure where there IS no
 * database - the pool itself could not be constructed, so neither
 * the heartbeat nor the alert table exists to work with. The alert
 * goes straight to Telegram, throttled in-process to one per 24h
 * (a process restart can re-arm it, once - bounded noise, and the
 * alternative is silence). The returned summary always carries the
 * failure, alerted or not, so every caller surface sees it. Never
 * throws, like evaluateResearchHealth.
 */
export async function reportResearchConfigFailure(
  notifier: TelegramNotifier | null,
  detail: string,
  now: Date = new Date(),
): Promise<HealthSummary> {
  const summary: HealthSummary = { alertsSent: [], recovered: [], failure: detail };
  try {
    const throttled =
      lastConfigAlertAtMs !== null && now.getTime() - lastConfigAlertAtMs < CONFIG_ALERT_THROTTLE_MS;
    if (notifier && !throttled) {
      const sent = await notifier.notifyOwner(`Research engine health: ${detail}`);
      if (sent) {
        lastConfigAlertAtMs = now.getTime();
        summary.alertsSent.push(RUNNER_CONFIG_MISSING_ISSUE);
      }
    }
  } catch (err) {
    console.error("[research] config-failure report failed", err);
  }
  return summary;
}

/** Detect issues, alert (throttled), and report recoveries. Never throws. */
export async function evaluateResearchHealth(
  db: Queryable,
  notifier: TelegramNotifier | null,
  config: ResearchConfig,
  now: Date = new Date(),
): Promise<HealthSummary> {
  const summary: HealthSummary = { alertsSent: [], recovered: [] };
  try {
    const issues = await detectHealthIssues(db, config, now);
    const currentKeys = new Set(issues.map((i) => i.key));

    for (const issue of issues) {
      const { rows } = await db.query<AlertRow>(
        `select issue_key, last_alerted_at, active from research_health_alerts where issue_key = $1`,
        [issue.key],
      );
      const existing = rows[0];
      const throttleActive =
        existing?.active &&
        existing.last_alerted_at !== null &&
        now.getTime() - Date.parse(existing.last_alerted_at) < 24 * HOUR_MS;

      await db.query(
        `insert into research_health_alerts (issue_key, company_id, detail, active, last_seen_at, recovered_at)
         values ($1, $2, $3, true, now(), null)
         on conflict (issue_key) do update set
           company_id = excluded.company_id,
           detail = excluded.detail,
           active = true,
           last_seen_at = now(),
           recovered_at = null`,
        [issue.key, issue.companyId, issue.detail],
      );

      if (!throttleActive) {
        const sent = notifier ? await notifier.notifyOwner(`Research engine health: ${issue.detail}`) : false;
        if (sent || !notifier) {
          await db.query(
            `update research_health_alerts set last_alerted_at = now() where issue_key = $1`,
            [issue.key],
          );
          if (sent) summary.alertsSent.push(issue.key);
        }
      }
    }

    const { rows: active } = await db.query<AlertRow>(
      `select issue_key, last_alerted_at, active from research_health_alerts where active = true`,
    );
    for (const row of active) {
      if (!currentKeys.has(row.issue_key)) {
        await db.query(
          `update research_health_alerts set active = false, recovered_at = now() where issue_key = $1`,
          [row.issue_key],
        );
        summary.recovered.push(row.issue_key);
        if (notifier) {
          await notifier.notifyOwner(`Research engine health: recovered - "${row.issue_key}" is clear again.`);
        }
      }
    }
  } catch (err) {
    console.error("[research] health evaluation failed", err);
  }
  return summary;
}
