// Abel Intelligence Upgrade, Phase D (design §5.4). The weekly
// true-pay report's delivery: same in-process scheduler pattern as
// the night shift (hourly check-in, due-ness from database state,
// never process memory), riding the same invokers - the in-process
// interval below, and the Research lane's always-on endpoint right
// next to the consolidation due-check (wired in
// src/app/api/internal/research/run/route.ts).
//
// Due rule: each tick scans the last TWO completed Mon-Sun weeks,
// oldest first, and handles at most one delivery -
// - no run row for a week yet -> due;
// - a run row exists with sent=false because the SEND failed ->
//   due again after 24h (a Telegram hiccup must not eat a week's
//   pay truth);
// - a week with NO settlements is NOT closed immediately: a
//   settlement photo can land late, so the week stays open until
//   10 days past its end, then closes silently (figures recorded,
//   nothing sent - a weekly "nothing arrived" nag is spam, and he
//   can always ask Abel for the report directly). The two-week scan
//   is what lets an empty week ever reach that close window, and
//   lets a week the job slept through still get its report.
// Gated on the bot_chat capability (it is Abel talking) and on the
// settlements table existing (migration 00045): without either, the
// job stays quiet instead of erroring hourly.

import { getIndustryBriefingPool } from "@/services/db/industry-briefing-pool";
import type { BotBrainStore } from "@/services/bot/store";
import { createTelegramBrainStore } from "@/services/telegram/store";
import { createTelegramNotifier } from "@/services/telegram/notify";
import { addDays, buildWeeklyReportForStore, lastCompletedWeekStart } from "./pay-report";
import { deliveryDecision, type DeliveryDecision } from "@/services/research/delivery";
import { getResearchConfig } from "@/services/research/config";

const CHECK_IN_MS = 60 * 60 * 1000;

/** Advisory-lock key for the pay report (727001 research, 727002 consolidation, 727003 the maintenance watcher's - distinct jobs never block each other). */
export const PAY_REPORT_LOCK_KEY = 727004;

const SEND_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const EMPTY_WEEK_CLOSE_AFTER_MS = 10 * 24 * 60 * 60 * 1000;

let started = false;

interface LockHandle {
  release(): Promise<void>;
}

const UNLOCKED: LockHandle = { release: async () => {} };

/** Same transport story as the consolidation lock (CD-2 pattern): a dedicated pool connection, or the loud UNLOCKED sentinel when the job database isn't configured. */
async function acquirePayReportLock(): Promise<LockHandle | null> {
  let pool;
  try {
    pool = getIndustryBriefingPool();
  } catch {
    console.error(
      "[pay-report] INDUSTRY_BRIEFING_DB_URL is not configured - running WITHOUT the cross-machine advisory lock",
    );
    return UNLOCKED;
  }
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean } & Record<string, unknown>>(
      "select pg_try_advisory_lock($1) as locked",
      [PAY_REPORT_LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return {
    release: async () => {
      try {
        await client.query("select pg_advisory_unlock($1)", [PAY_REPORT_LOCK_KEY]);
      } catch {
        // Session locks die with the connection regardless.
      } finally {
        client.release();
      }
    },
  };
}

export interface PayReportDueDeps {
  store: BotBrainStore | null;
  acquireLock: () => Promise<LockHandle | null>;
  notify: (text: string) => Promise<boolean>;
  now: () => Date;
  /** UH-06 fix (injectable for tests): the shared delivery gate — same deliveryDecision the maintenance watcher consults. */
  deliveryGate?: (store: BotBrainStore, now: Date) => Promise<DeliveryDecision>;
}

/** UH-06 fix: the pay report is a proactive Telegram send, so it goes
 * through the SAME deliveryDecision as every other routine buzz
 * (quiet hours 21:00–06:00 ET + driving/on-duty hold). Duty status is
 * read from his latest duty log; a read failure degrades to "unknown"
 * (null), never to a crash — quiet hours still apply. */
async function defaultDeliveryGate(store: BotBrainStore, now: Date): Promise<DeliveryDecision> {
  let latestDutyStatus: string | null = null;
  try {
    const { data } = await store.client
      .from("duty_logs")
      .select("duty_status")
      .eq("company_id", store.companyId)
      .is("deleted_at", null)
      .order("started_at", { ascending: false })
      .limit(1);
    const row = (data ?? [])[0] as { duty_status?: string } | undefined;
    latestDutyStatus = row?.duty_status ?? null;
  } catch {
    latestDutyStatus = null;
  }
  return deliveryDecision({
    now,
    deliveryClass: "routine",
    latestDutyStatus,
    config: getResearchConfig(),
  });
}

/**
 * The due-check, exported self-contained like runConsolidationIfDue
 * (CD-1 contract): safe to call hourly from anywhere, never throws.
 * The zero-argument call is the contract; overrides exist for tests.
 */
export async function runWeeklyPayReportIfDue(
  overrides: Partial<PayReportDueDeps> = {},
): Promise<void> {
  try {
    const store =
      overrides.store !== undefined
        ? overrides.store
        : createTelegramBrainStore(process.env.TELEGRAM_COMPANY_ID ?? null);
    if (!store) return; // Telegram env not configured here - the job doesn't exist on this server.

    if (!(await store.isBotChatEnabled())) return; // Abel is off; his reports are too.

    const now = (overrides.now ?? (() => new Date()))();
    const newestWeek = lastCompletedWeekStart(now);
    const weeks = [addDays(newestWeek, -7), newestWeek]; // oldest first

    const acquireLock = overrides.acquireLock ?? acquirePayReportLock;
    const lock = await acquireLock();
    if (!lock) {
      console.log("[pay-report] another run holds the advisory lock - skipping this due-check");
      return;
    }
    try {
      const notify = overrides.notify ?? ((text: string) => createTelegramNotifier().notifyOwner(text));
      for (const weekStart of weeks) {
        const weekEnd = addDays(weekStart, 6);
        const existing = await store.payReportRunForWeek(weekStart);
        if (existing?.sent || existing?.closedEmpty) continue;
        if (
          existing &&
          now.getTime() - new Date(existing.createdAt).getTime() < SEND_RETRY_AFTER_MS
        ) {
          continue; // A failed send inside the last day - don't hammer.
        }
        const report = await buildWeeklyReportForStore(store, weekStart);
        if (report.figures.settlementCount === 0) {
          // Keep the week open for a late settlement photo until
          // the close window passes; then record it silently.
          if (now.getTime() - new Date(`${weekEnd}T00:00:00.000Z`).getTime() >= EMPTY_WEEK_CLOSE_AFTER_MS) {
            // sent stays false - nothing was delivered; closedEmpty
            // is what marks the week decided (payReportRunForWeek).
            await store.recordPayReportRun(weekStart, false, { ...report.figures, closedEmpty: true });
          }
          continue;
        }
        // UH-06 fix: held by quiet hours / driving -> do NOT send
        // and do NOT record the run; the next hourly tick re-checks
        // and releases it at the first sendable moment — the same
        // release behavior as the maintenance watcher's digest.
        const gate = overrides.deliveryGate ?? defaultDeliveryGate;
        const verdict = await gate(store, now);
        if (!verdict.sendNow) {
          console.log(
            `[pay-report] weekly report for ${weekStart} held by delivery decision (${verdict.reason ?? "held"}) - will re-check next tick`,
          );
          return;
        }
        const sent = await notify(report.text);
        await store.recordPayReportRun(weekStart, sent, { ...report.figures });
        if (!sent) {
          console.error("[pay-report] weekly report built but Telegram delivery failed - will retry after the cool-off");
        }
        return; // One delivery per tick - an older missed week and this week's never land in the same minute.
      }
    } finally {
      await lock.release();
    }
  } catch (err) {
    console.error("[pay-report] due-check failed", err);
  }
}

export function startPayReportScheduler(): void {
  if (started) return;
  started = true;
  // One immediate due-check, then hourly - the consolidation
  // scheduler's rhythm exactly.
  void runWeeklyPayReportIfDue();
  setInterval(() => {
    void runWeeklyPayReportIfDue();
  }, CHECK_IN_MS);
}
