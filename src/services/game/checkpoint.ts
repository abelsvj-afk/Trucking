// Gaming System monthly checkpoints (docs/design/gaming-system.md
// §4.3). On the 1st (America/New_York) the prior month closes:
// planned vs actual for the primary metric, an arithmetic verdict,
// ONE lever named for next month, and a single Telegram digest.
// Checkpoints are information, never actions - closing one never
// edits a target, a sweep, or a milestone; the re-game that follows
// is the runner's ordinary versioned flow.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addMonthsToKey, monthKeyOf, GAME_METRIC_LABELS } from "@/lib/game-plan";
import { buildCheckpointDigest, checkpointVerdict } from "@/lib/game-text";
import { formatDollars } from "@/lib/truck-fund";
import type { TelegramNotifier } from "@/services/telegram/notify";
import type { GameCheckpoint, GameMetric, GamePlan, GameTarget } from "@/types/entities";
import { isGamePlanEnabled, loadActiveTarget } from "./run-game-plan";

/** Today's date in America/New_York as YYYY-MM-DD (design §2.5: ET months). */
export function etDateString(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The month a tick at `now` should close: the ET month just ended. */
export function monthToClose(now: Date = new Date()): string {
  const currentKey = monthKeyOf(etDateString(now));
  return addMonthsToKey(currentKey, -1);
}

function monthBounds(monthKey: string): { from: string; to: string } {
  const next = addMonthsToKey(monthKey, 1);
  return { from: `${monthKey}-01`, to: `${next}-01` };
}

function monthEndDate(monthKey: string): string {
  const { to } = monthBounds(monthKey);
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface MonthActual {
  valueCents: number;
  hasRecords: boolean;
  maintenanceTotalCents: number;
  biggestMaintenance: { costCents: number; description: string; date: string } | null;
}

async function fundBalanceAt(
  client: SupabaseClient,
  companyId: string,
  fundKey: string,
  date: string,
): Promise<number> {
  const { data, error } = await client
    .from("fund_entries")
    .select("kind, amount_cents")
    .eq("company_id", companyId)
    .eq("fund_key", fundKey)
    .is("deleted_at", null)
    .lte("entry_date", date)
    .limit(2000);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { kind: string; amount_cents: number }[]).reduce(
    (t, e) => t + (e.kind === "deposit" ? e.amount_cents : -e.amount_cents),
    0,
  );
}

/** What actually happened in a month, for the target's metric. */
export async function metricActualForMonth(
  client: SupabaseClient,
  companyId: string,
  metric: GameMetric,
  monthKey: string,
): Promise<MonthActual> {
  const { from, to } = monthBounds(monthKey);
  const end = monthEndDate(monthKey);

  const [loadsResult, expensesResult, fuelResult, maintenanceResult] = await Promise.all([
    client
      .from("loads")
      .select("rate_cents, pickup_date, delivery_date")
      .eq("company_id", companyId)
      .in("status", ["confirmed", "completed"])
      .is("deleted_at", null)
      .limit(1000),
    client
      .from("expenses")
      .select("amount_cents")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("expense_date", from)
      .lt("expense_date", to)
      .limit(1000),
    client
      .from("fuel_purchases")
      .select("total_cost_cents")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("purchased_at", `${from}T00:00:00Z`)
      .lt("purchased_at", `${to}T00:00:00Z`)
      .limit(1000),
    client
      .from("maintenance_events")
      .select("cost_cents, service_date, description")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("service_date", from)
      .lt("service_date", to)
      .limit(1000),
  ]);
  for (const result of [loadsResult, expensesResult, fuelResult, maintenanceResult]) {
    if (result.error) throw new Error(result.error.message);
  }

  const loads = (loadsResult.data ?? []) as {
    rate_cents: number | null;
    pickup_date: string | null;
    delivery_date: string | null;
  }[];
  const revenue = loads.reduce((t, load) => {
    const d = load.delivery_date ?? load.pickup_date;
    return d != null && d >= from && d < to ? t + (load.rate_cents ?? 0) : t;
  }, 0);
  const expenses = ((expensesResult.data ?? []) as { amount_cents: number }[]).reduce(
    (t, e) => t + e.amount_cents,
    0,
  );
  const fuel = ((fuelResult.data ?? []) as { total_cost_cents: number }[]).reduce(
    (t, f) => t + f.total_cost_cents,
    0,
  );
  const maintenanceRows = (maintenanceResult.data ?? []) as {
    cost_cents: number | null;
    service_date: string;
    description: string;
  }[];
  const maintenanceTotal = maintenanceRows.reduce((t, m) => t + (m.cost_cents ?? 0), 0);
  const biggest = maintenanceRows.reduce<(typeof maintenanceRows)[number] | null>(
    (best, m) => (best == null || (m.cost_cents ?? 0) > (best.cost_cents ?? 0) ? m : best),
    null,
  );
  const monthlyNet = revenue - expenses - fuel - maintenanceTotal;
  const hasRecords =
    revenue !== 0 || expenses !== 0 || fuel !== 0 || maintenanceRows.length > 0;

  const result: MonthActual = {
    valueCents: monthlyNet,
    hasRecords,
    maintenanceTotalCents: maintenanceTotal,
    biggestMaintenance: biggest
      ? { costCents: biggest.cost_cents ?? 0, description: biggest.description, date: biggest.service_date }
      : null,
  };

  if (metric === "monthly_net_cents") return result;

  const truckFund = await fundBalanceAt(client, companyId, "truck_fund", end);
  if (metric === "truck_fund_cents") return { ...result, valueCents: truckFund };

  const [emergency, businessCredit] = await Promise.all([
    fundBalanceAt(client, companyId, "emergency_fund", end),
    fundBalanceAt(client, companyId, "business_credit", end),
  ]);
  const { data: snapshotRows, error: snapshotError } = await client
    .from("account_snapshots")
    .select("institution, account_name, last4, balance_cents, lane, as_of_date")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .lte("as_of_date", end)
    .limit(200);
  if (snapshotError) throw new Error(snapshotError.message);
  const latest = new Map<string, { balance_cents: number; lane: string; as_of_date: string }>();
  for (const row of (snapshotRows ?? []) as {
    institution: string;
    account_name: string;
    last4: string;
    balance_cents: number;
    lane: string;
    as_of_date: string;
  }[]) {
    const key = `${row.institution}|${row.account_name}|${row.last4}`;
    const existing = latest.get(key);
    if (!existing || row.as_of_date > existing.as_of_date) latest.set(key, row);
  }
  let debts = 0;
  let personal = 0;
  for (const row of latest.values()) {
    if (row.balance_cents < 0) debts += -row.balance_cents;
    else if (row.lane === "personal") personal += row.balance_cents;
  }
  // Crude in exactly the engine's way (§1.1): fund balances minus
  // known debts; the truck itself only counts once a snapshot or a
  // later increment can price it - the checkpoint says so by using
  // the same formula the plan projected from.
  const businessValue = truckFund + emergency + businessCredit - debts;
  return {
    ...result,
    valueCents: metric === "business_value_cents" ? businessValue : businessValue + personal,
  };
}

async function planForMonth(
  client: SupabaseClient,
  companyId: string,
  target: GameTarget,
  monthKey: string,
): Promise<{ plan: GamePlan; plannedCents: number } | null> {
  const { data, error } = await client
    .from("game_plans")
    .select("*")
    .eq("company_id", companyId)
    .eq("target_id", target.id)
    .in("status", ["current", "superseded"])
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  const plans = (data ?? []) as GamePlan[];
  if (plans.length === 0) return null;

  const monthStart = `${monthKey}-01`;
  const startedOn = plans.filter((p) => p.created_at.slice(0, 10) < monthStart);
  const during = plans.filter((p) => monthKeyOf(p.created_at.slice(0, 10)) === monthKey);
  const chosen = startedOn[startedOn.length - 1] ?? during[0] ?? plans[plans.length - 1]!;

  const points = chosen.scenarios.scenarios.recommended.points;
  const point =
    points.find((p) => p.month === monthKey) ??
    points.find((p) => p.month > monthKey) ??
    points[points.length - 1]!;
  return { plan: chosen, plannedCents: point.metricCents };
}

export type CheckpointOutcome =
  | { status: "skipped_disabled" }
  | { status: "no_target" }
  | { status: "no_plan" }
  | { status: "already_closed"; monthKey: string }
  | { status: "closed"; checkpoint: GameCheckpoint; digestSent: boolean };

/**
 * Closes the just-ended ET month if it isn't closed yet. Idempotent:
 * the unique index backs this check, so a double tick can never
 * double-close or double-send.
 */
export async function closeMonthlyCheckpoint(input: {
  client: SupabaseClient;
  companyId: string;
  notifier: TelegramNotifier | null;
  now?: Date;
}): Promise<CheckpointOutcome> {
  const { client, companyId } = input;
  const now = input.now ?? new Date();

  if (!(await isGamePlanEnabled(client, companyId))) return { status: "skipped_disabled" };
  const target = await loadActiveTarget(client, companyId);
  if (!target) return { status: "no_target" };

  const monthKey = monthToClose(now);
  const { data: existing, error: existingError } = await client
    .from("game_checkpoints")
    .select("*")
    .eq("company_id", companyId)
    .eq("target_id", target.id)
    .eq("period_month", `${monthKey}-01`)
    .is("deleted_at", null)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing && (existing as GameCheckpoint).actual_value_cents != null) {
    return { status: "already_closed", monthKey };
  }

  const plannedResult = await planForMonth(client, companyId, target, monthKey);
  if (!plannedResult) return { status: "no_plan" };
  const { plan, plannedCents } = plannedResult;

  const actual = await metricActualForMonth(client, companyId, target.metric, monthKey);
  const verdict = checkpointVerdict({
    plannedCents,
    actualCents: actual.valueCents,
    hasRecords: actual.hasRecords,
  });
  const gap = actual.hasRecords ? actual.valueCents - plannedCents : null;

  // The one lever (design §4.3): the current plan's biggest
  // adjustable lever, or "hold the course" when ahead/on plan.
  const { data: currentRows, error: currentError } = await client
    .from("game_plans")
    .select("*")
    .eq("company_id", companyId)
    .eq("target_id", target.id)
    .eq("status", "current")
    .is("deleted_at", null)
    .order("version", { ascending: false })
    .limit(1);
  if (currentError) throw new Error(currentError.message);
  const current = ((currentRows ?? []) as GamePlan[])[0];
  let leverNote = "hold the course";
  if (verdict === "behind" && current) {
    const top = [...current.scenarios.levers]
      .filter((l) => l.contributionCents > 0)
      .sort((a, b) => b.contributionCents - a.contributionCents)[0];
    if (top) {
      leverNote = `${top.label} - worth about ${formatDollars(top.contributionCents)} toward the gap by the target date (projection)`;
    }
  }

  const causeLine =
    verdict === "no_data"
      ? "no loads, expenses, fuel, or repairs were recorded this month"
      : verdict === "behind" && actual.biggestMaintenance && actual.maintenanceTotalCents > 0
        ? `maintenance ate ${formatDollars(actual.maintenanceTotalCents)} (${actual.biggestMaintenance.description}, ${actual.biggestMaintenance.date})`
        : verdict === "behind"
          ? `the month closed ${formatDollars(Math.abs(gap ?? 0))} under the plan's projected mark`
          : verdict === "ahead"
            ? `the month closed ${formatDollars(Math.abs(gap ?? 0))} over the plan's projected mark`
            : "the month landed on the plan's projected mark";

  const monthLabel = new Date(`${monthKey}-15T00:00:00Z`).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  const digest = buildCheckpointDigest({
    monthLabel,
    planVersion: plan.version,
    metricLabel: GAME_METRIC_LABELS[target.metric],
    verdict,
    gapCents: gap,
    causeLine,
    truckWindowMonth: current?.scenarios.scenarios.recommended.milestones.truckWindowMonth ?? null,
    leverNote,
  });

  const row = {
    company_id: companyId,
    target_id: target.id,
    period_month: `${monthKey}-01`,
    planned_value_cents: plannedCents,
    actual_value_cents: actual.hasRecords ? actual.valueCents : null,
    verdict,
    gap_cents: gap,
    lever_note: leverNote,
    telegram_sent_at: null as string | null,
  };

  let checkpoint: GameCheckpoint;
  if (existing) {
    const { data, error } = await client
      .from("game_checkpoints")
      .update(row)
      .eq("id", (existing as GameCheckpoint).id)
      .eq("company_id", companyId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    checkpoint = data as GameCheckpoint;
  } else {
    const { data, error } = await client
      .from("game_checkpoints")
      .insert(row)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    checkpoint = data as GameCheckpoint;
  }

  let digestSent = false;
  if (input.notifier) {
    digestSent = await input.notifier.notifyOwner(digest);
    if (digestSent) {
      const { error } = await client
        .from("game_checkpoints")
        .update({ telegram_sent_at: new Date().toISOString() })
        .eq("id", checkpoint.id)
        .eq("company_id", companyId);
      if (error) throw new Error(error.message);
      checkpoint = { ...checkpoint, telegram_sent_at: new Date().toISOString() };
    }
  }

  return { status: "closed", checkpoint, digestSent };
}
