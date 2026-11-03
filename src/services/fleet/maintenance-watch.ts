// The maintenance watcher (Image Intelligence design §5.6):
// the background pass that turns the maintenance brain's state
// into reminders - so a due oil change surfaces on its own
// instead of waiting for him to ask. Cloned from the
// consolidation night shift's shape (consolidation-scheduler.ts):
// due-ness from database state (maintenance_watch_runs), a
// Postgres advisory lock (727003 - research is 727001,
// consolidation 727002) on the industry-briefing pool, two
// invocation doors (the research endpoint's piggyback and the
// in-process hourly scheduler), and a Settings kill switch
// (maintenance_watch) that makes the whole pass a no-op.
//
// The reminder policy is STATE, never memory (§5.6): a schedule's
// last_reminder_key holds "<nextDueDate>:<nextDueMileage>|<tier>|
// <fire count>" for the due point it was last reminded about, so
// a reminder re-fires only when the due point moves, the tier
// changes, or the tier's cadence says so. Routine items aggregate
// into at most ONE digest per day, released through the research
// lane's imported deliveryDecision (quiet hours / driving holds);
// urgent items (the DOT annual at 7 days, a safety item overdue
// on a driving day) send immediately, once per tier.

import { getIndustryBriefingPool } from "@/services/db/industry-briefing-pool";
import { getResearchConfig } from "@/services/research/config";
import { deliveryDecision } from "@/services/research/delivery";
import { createTelegramBrainStore } from "@/services/telegram/store";
import { createTelegramNotifier } from "@/services/telegram/notify";
import type { BotBrainStore } from "@/services/bot/store";
import {
  computeMaintenanceOutlook,
  type MaintenanceOutlook,
  type ScheduleOutlook,
} from "@/services/fleet/maintenance-outlook";

export const MAINTENANCE_WATCH_CAPABILITY = "maintenance_watch";

/** Advisory-lock key for the watch pass. Distinct from research (727001) and consolidation (727002) - the jobs never block each other. */
export const MAINTENANCE_WATCH_LOCK_KEY = 727003;

const CHECK_IN_MS = 60 * 60 * 1000;
const DUE_AFTER_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export interface WatchLedger {
  /** ET date (yyyy-mm-dd) of the last digest sent. */
  digestDate: string | null;
  /** scheduleId -> ISO date the unknown-state note was folded into a SENT digest. */
  unknownNotified: Record<string, string>;
  /** truckId -> ISO timestamp of the last stale-mileage notice sent. */
  staleSentAt: Record<string, string>;
}

const EMPTY_LEDGER: WatchLedger = { digestDate: null, unknownNotified: {}, staleSentAt: {} };

interface ReminderCandidate {
  kind: "schedule" | "defect" | "stale_mileage" | "unknown_schedule";
  urgent: boolean;
  text: string;
  /** State to stamp when (and only when) this candidate is actually sent. */
  stamp: (sentAt: Date) => Promise<void>;
  scheduleId?: string;
}

export interface WatchPassResult {
  ran: boolean;
  urgentSent: number;
  digestSent: boolean;
  routineHeld: number;
  reason?: string;
}

// ---------------------------------------------------------------------
// Reminder-key state
// ---------------------------------------------------------------------

interface ParsedReminderKey {
  dueKey: string;
  tier: string;
  count: number;
}

function dueKeyOf(entry: ScheduleOutlook): string {
  return `${entry.due.nextDueDate ?? ""}:${entry.due.nextDueMileage ?? ""}`;
}

function parseReminderKey(raw: string | null): ParsedReminderKey | null {
  if (!raw) return null;
  const [dueKey, tier, count] = raw.split("|");
  if (!dueKey || !tier) return null;
  return { dueKey, tier, count: Number.parseInt(count ?? "0", 10) || 0 };
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / DAY_MS);
}

function etDateString(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

function fmtMiles(miles: number): string {
  return Math.round(miles).toLocaleString("en-US");
}

// ---------------------------------------------------------------------
// Candidate building (the §5.6 policy table)
// ---------------------------------------------------------------------

interface BuildContext {
  store: BotBrainStore;
  outlook: MaintenanceOutlook;
  now: Date;
  ledger: WatchLedger;
  latestDutyStatus: string | null;
}

async function stampSchedule(
  store: BotBrainStore,
  scheduleId: string,
  key: string,
  sentAt: Date,
): Promise<void> {
  const { error } = await store.client
    .from("maintenance_schedules")
    .update({ last_reminder_key: key, last_reminded_at: sentAt.toISOString() })
    .eq("id", scheduleId)
    .eq("company_id", store.companyId)
    .is("deleted_at", null);
  if (error) console.error("[maintenance-watch] reminder stamp failed", error.message);
}

function scheduleCandidate(
  ctx: BuildContext,
  entry: ScheduleOutlook,
  tier: string,
  count: number,
  urgent: boolean,
  text: string,
): ReminderCandidate {
  const key = `${dueKeyOf(entry)}|${tier}|${count}`;
  return {
    kind: "schedule",
    urgent,
    text,
    scheduleId: entry.schedule.id,
    stamp: (sentAt) => stampSchedule(ctx.store, entry.schedule.id, key, sentAt),
  };
}

function buildScheduleCandidates(ctx: BuildContext): ReminderCandidate[] {
  const { outlook, now, ledger } = ctx;
  const candidates: ReminderCandidate[] = [];
  const today = now.toISOString().slice(0, 10);

  for (const entry of outlook.schedules) {
    const { schedule, due } = entry;
    if (schedule.status === "paused") continue;
    const stored = parseReminderKey(schedule.last_reminder_key);
    const dueKey = dueKeyOf(entry);
    const sameDue = stored?.dueKey === dueKey;
    const lastRemindedDays =
      schedule.last_reminded_at != null ? daysBetween(new Date(schedule.last_reminded_at), now) : null;

    // DOT annual: the legal deadline gets its own ladder (30/14/7
    // days), computed off the due DATE regardless of the generic
    // due-soon window. The 7-day rung is urgent - it goes out
    // immediately, even in quiet hours, once.
    if (schedule.template_key === "dot_annual" && due.nextDueDate) {
      const daysUntil = daysBetween(
        new Date(`${today}T00:00:00Z`),
        new Date(`${due.nextDueDate}T00:00:00Z`),
      );
      const tier =
        daysUntil <= 7 ? "dot_7" : daysUntil <= 14 ? "dot_14" : daysUntil <= 30 ? "dot_30" : null;
      if (tier && (!sameDue || stored!.tier !== tier)) {
        candidates.push(
          scheduleCandidate(
            ctx,
            entry,
            tier,
            1,
            tier === "dot_7",
            tier === "dot_7"
              ? `⚠️ The DOT annual inspection on ${entry.vehicleLabel} is due in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (by ${due.nextDueDate}) - that's the legal one; it needs a certified inspection before the date passes.`
              : `The DOT annual inspection on ${entry.vehicleLabel} is due ${due.nextDueDate} - ${daysUntil} days out. Worth getting on a shop's calendar.`,
          ),
        );
      }
      continue;
    }

    if (due.status === "unknown") {
      // Once, folded into a digest, never again (§5.6).
      if (!ledger.unknownNotified[schedule.id]) {
        candidates.push({
          kind: "unknown_schedule",
          urgent: false,
          text: `${schedule.description} on ${entry.vehicleLabel}: no last-done on record, so I can't tell when it's due - tell me when it was last done and I'll track it from there.`,
          scheduleId: schedule.id,
          stamp: async (sentAt) => {
            ledger.unknownNotified[schedule.id] = sentAt.toISOString().slice(0, 10);
          },
        });
      }
      continue;
    }

    if (due.status === "due-soon") {
      if (!sameDue || stored!.tier !== "due_soon") {
        candidates.push(
          scheduleCandidate(
            ctx,
            entry,
            "due_soon",
            1,
            false,
            `${schedule.description} on ${entry.vehicleLabel} is coming due${due.nextDueDate ? ` by ${due.nextDueDate}` : ""}${due.nextDueMileage != null ? ` at ${fmtMiles(due.nextDueMileage)} mi` : ""}.`,
          ),
        );
      }
      continue;
    }

    if (due.status === "overdue") {
      const safety = entry.safety;
      const driving = ctx.latestDutyStatus === "driving";
      let fire = false;
      let count = 1;
      if (!sameDue || stored!.tier !== "overdue") {
        fire = true;
        count = sameDue && stored ? stored.count + 1 : 1;
      } else if (lastRemindedDays != null) {
        // Cadence: safety items twice a week; routine weekly for
        // the first four fires, then monthly (§5.6).
        const intervalDays = safety ? 3 : stored!.count >= 4 ? 30 : 7;
        if (lastRemindedDays >= intervalDays) {
          fire = true;
          count = stored!.count + 1;
        }
      }
      if (fire) {
        candidates.push(
          scheduleCandidate(
            ctx,
            entry,
            "overdue",
            count,
            safety && driving,
            `${safety ? "⚠️ " : ""}${schedule.description} on ${entry.vehicleLabel} is OVERDUE${due.nextDueDate ? ` (was due ${due.nextDueDate})` : ""}${due.nextDueMileage != null ? ` (due at ${fmtMiles(due.nextDueMileage)} mi)` : ""}.${safety ? " That's a safety item." : ""}`,
          ),
        );
      }
    }
  }
  return candidates;
}

function buildDefectCandidates(ctx: BuildContext): ReminderCandidate[] {
  const { outlook, now, store } = ctx;
  const candidates: ReminderCandidate[] = [];
  for (const defect of outlook.defects) {
    const ageDays = daysBetween(new Date(defect.created_at), now);
    const sinceFollowDays =
      defect.last_follow_up_at != null ? daysBetween(new Date(defect.last_follow_up_at), now) : null;
    const due =
      defect.follow_up_count === 0 ? ageDays >= 3 : sinceFollowDays != null && sinceFollowDays >= 7;
    if (!due) continue;
    candidates.push({
      kind: "defect",
      urgent: false,
      text: `Still open: the defect "${defect.description}" (first noted ${defect.created_at.slice(0, 10)}). If it's fixed, tell me and I'll close it; if it's the carrier's problem, say so and I'll stop asking.`,
      stamp: async (sentAt) => {
        const { error } = await store.client
          .from("vehicle_defects")
          .update({
            last_follow_up_at: sentAt.toISOString(),
            follow_up_count: defect.follow_up_count + 1,
          })
          .eq("id", defect.id)
          .eq("company_id", store.companyId)
          .is("deleted_at", null);
        if (error) console.error("[maintenance-watch] defect follow-up stamp failed", error.message);
      },
    });
  }
  return candidates;
}

function buildStaleMileageCandidates(ctx: BuildContext): ReminderCandidate[] {
  const { outlook, ledger } = ctx;
  const candidates: ReminderCandidate[] = [];
  for (const truck of outlook.trucks) {
    if (truck.mileageAgeDays == null || truck.mileageAgeDays <= 10) continue;
    const lastSent = ledger.staleSentAt[truck.truckId];
    if (lastSent && daysBetween(new Date(lastSent), ctx.now) < 10) continue;
    candidates.push({
      kind: "stale_mileage",
      urgent: false,
      text: `Truck ${truck.unitNumber}'s mileage (${truck.mileage != null ? fmtMiles(truck.mileage) : "not recorded"}) was last updated ${truck.mileageAgeDays} days ago - every due-by-miles figure is running on that old number. A dash photo or the number in words refreshes it.`,
      stamp: async (sentAt) => {
        ledger.staleSentAt[truck.truckId] = sentAt.toISOString();
      },
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------

export interface WatchDeps {
  store: BotBrainStore;
  notify: (text: string) => Promise<boolean>;
  now?: Date;
}

async function latestDutyStatus(store: BotBrainStore): Promise<string | null> {
  try {
    const { data, error } = await store.client
      .from("duty_logs")
      .select("duty_status")
      .eq("company_id", store.companyId)
      .is("deleted_at", null)
      .order("started_at", { ascending: false })
      .limit(1);
    if (error) return null;
    return ((data ?? []) as { duty_status: string }[])[0]?.duty_status ?? null;
  } catch {
    return null;
  }
}

interface WatchRunRow {
  ran_at: string;
  detail: { ledger?: Partial<WatchLedger> } | null;
}

async function latestWatchRun(store: BotBrainStore): Promise<WatchRunRow | null | "unavailable"> {
  const { data, error } = await store.client
    .from("maintenance_watch_runs")
    .select("ran_at, detail")
    .eq("company_id", store.companyId)
    .order("ran_at", { ascending: false })
    .limit(1);
  if (error) {
    if (/does not exist/i.test(error.message)) return "unavailable";
    throw new Error(error.message);
  }
  return ((data ?? []) as WatchRunRow[])[0] ?? null;
}

/**
 * One full evaluation + delivery pass (what the due-check calls
 * once the lock is held). Never throws for delivery problems -
 * a failed send stamps nothing, so the item re-collects next
 * pass instead of being marked reminded when he never saw it.
 */
export async function evaluateMaintenanceWatch(deps: WatchDeps): Promise<WatchPassResult> {
  const { store, notify } = deps;
  const now = deps.now ?? new Date();

  const lastRun = await latestWatchRun(store);
  if (lastRun === "unavailable") {
    console.error("[maintenance-watch] maintenance_watch_runs is missing - migration 00042 not applied; the watch is standing down");
    return { ran: false, urgentSent: 0, digestSent: false, routineHeld: 0, reason: "migration_missing" };
  }
  const ledger: WatchLedger = {
    ...EMPTY_LEDGER,
    ...(lastRun?.detail?.ledger ?? {}),
    unknownNotified: { ...(lastRun?.detail?.ledger?.unknownNotified ?? {}) },
    staleSentAt: { ...(lastRun?.detail?.ledger?.staleSentAt ?? {}) },
  };

  const outlook = await computeMaintenanceOutlook(store.client, store.companyId, now);
  const duty = await latestDutyStatus(store);
  const ctx: BuildContext = { store, outlook, now, ledger, latestDutyStatus: duty };
  const candidates = [
    ...buildScheduleCandidates(ctx),
    ...buildDefectCandidates(ctx),
    ...buildStaleMileageCandidates(ctx),
  ];

  let urgentSent = 0;
  let digestSent = false;
  let sentCount = 0;

  // Urgent items go out immediately, one message each (§5.6) -
  // deliveryDecision's urgent class never holds, called anyway
  // so the rule lives in exactly one place.
  const config = getResearchConfig();
  for (const candidate of candidates.filter((c) => c.urgent)) {
    const verdict = deliveryDecision({ now, deliveryClass: "urgent", latestDutyStatus: duty, config });
    if (!verdict.sendNow) continue;
    const sent = await notify(candidate.text);
    if (sent) {
      await candidate.stamp(now);
      urgentSent += 1;
      sentCount += 1;
    }
  }

  // Routine items: at most one digest per day, released at the
  // first non-quiet, non-driving moment (the imported decision).
  const routine = candidates.filter((c) => !c.urgent);
  let routineHeld = 0;
  if (routine.length > 0) {
    const todayEt = etDateString(now);
    const verdict = deliveryDecision({ now, deliveryClass: "routine", latestDutyStatus: duty, config });
    if (verdict.sendNow && ledger.digestDate !== todayEt) {
      const text = ["🔧 Maintenance watch —", ...routine.map((c) => `• ${c.text}`)].join("\n");
      const sent = await notify(text);
      if (sent) {
        for (const candidate of routine) await candidate.stamp(now);
        ledger.digestDate = todayEt;
        digestSent = true;
        sentCount += routine.length;
      } else {
        routineHeld = routine.length;
      }
    } else {
      routineHeld = routine.length;
    }
  }

  // The run row always lands - it IS the due-check's clock and
  // the ledger's home.
  const { error: runError } = await store.client.from("maintenance_watch_runs").insert({
    company_id: store.companyId,
    ran_at: now.toISOString(),
    reminders_sent: sentCount,
    detail: {
      ledger,
      urgentSent,
      digestSent,
      routineHeld,
      candidates: candidates.length,
    },
  });
  if (runError) {
    console.error("[maintenance-watch] failed to record the watch run", runError.message);
  }

  return { ran: true, urgentSent, digestSent, routineHeld };
}

// ---------------------------------------------------------------------
// Due-check + lock + scheduler (the consolidation shape)
// ---------------------------------------------------------------------

export interface WatchLockHandle {
  release(): Promise<void>;
}

const UNLOCKED: WatchLockHandle = { release: async () => {} };

async function acquireWatchLock(): Promise<WatchLockHandle | null> {
  let pool;
  try {
    pool = getIndustryBriefingPool();
  } catch {
    console.error(
      "[maintenance-watch] INDUSTRY_BRIEFING_DB_URL is not configured - running this pass WITHOUT the cross-machine advisory lock",
    );
    return UNLOCKED;
  }
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean } & Record<string, unknown>>(
      "select pg_try_advisory_lock($1) as locked",
      [MAINTENANCE_WATCH_LOCK_KEY],
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
        await client.query("select pg_advisory_unlock($1)", [MAINTENANCE_WATCH_LOCK_KEY]);
      } catch {
        // Session locks die with the connection regardless.
      } finally {
        client.release();
      }
    },
  };
}

export interface MaintenanceWatchDueDeps {
  store: BotBrainStore | null;
  acquireLock: () => Promise<WatchLockHandle | null>;
  notify: (text: string) => Promise<boolean>;
  now: Date;
}

/**
 * The due-check: at most one pass per company per ~6 hours,
 * decided from maintenance_watch_runs, under the advisory lock.
 * Capability off = immediate return, zero messages (D5) - the
 * maintenance_outlook read tool keeps answering regardless,
 * because it never comes through here. Never throws.
 */
export async function runMaintenanceWatchIfDue(
  overrides: Partial<MaintenanceWatchDueDeps> = {},
): Promise<void> {
  try {
    const store =
      overrides.store !== undefined
        ? overrides.store
        : createTelegramBrainStore(process.env.TELEGRAM_COMPANY_ID ?? null);
    if (!store) return;

    if (!(await store.isMaintenanceWatchEnabled())) return;

    const now = overrides.now ?? new Date();
    const lastRun = await latestWatchRun(store);
    if (lastRun === "unavailable") {
      console.error("[maintenance-watch] migration 00042 not applied - the watch is standing down");
      return;
    }
    if (lastRun && now.getTime() - new Date(lastRun.ran_at).getTime() < DUE_AFTER_MS) return;

    const acquireLock = overrides.acquireLock ?? acquireWatchLock;
    const lock = await acquireLock();
    if (!lock) {
      console.log("[maintenance-watch] another run holds the advisory lock - skipping this due-check");
      return;
    }
    try {
      const notify =
        overrides.notify ?? ((text: string) => createTelegramNotifier().notifyOwner(text));
      await evaluateMaintenanceWatch({ store, notify, now });
    } finally {
      await lock.release();
    }
  } catch (err) {
    console.error("[maintenance-watch] due-check failed", err);
  }
}

let started = false;

/** Idempotent - safe to call more than once. */
export function startMaintenanceWatchScheduler(): void {
  if (started) return;
  started = true;
  setInterval(() => void runMaintenanceWatchIfDue(), CHECK_IN_MS);
  void runMaintenanceWatchIfDue();
}
