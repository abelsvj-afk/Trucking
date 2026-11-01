// Truck Fund aggregate (docs/design/driver-mvp.md §9, contract in
// docs/api-contracts.md). Computed, read-only - like
// /financial-summary, it is not backed by a single table. All math
// lives in src/lib/truck-fund.ts (pure, unit-tested); this route only
// fetches rows, normalizes them (fuel's purchased_at timestamptz is
// sliced to its UTC date; load placement follows the financial
// summary's delivery_date -> pickup_date rule, completed loads only),
// and maps the lib's camelCase results to the API's snake_case.
//
// The app never moves money: the `suggestion` here is a number and a
// sentence. Recording it is a separate POST to /fund-entries that the
// owner makes explicitly.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import {
  aggregatePeriod,
  buildLadderView,
  computeProgress,
  computeSuggestion,
  monthRange,
  summarizeFunds,
  weekRange,
  type PeriodCostRow,
  type PeriodLoadRow,
  type PeriodTotals,
} from "@/lib/truck-fund";
import { manualSnapshotAccountVisibility } from "@/services/fund/account-visibility";
import type { BusinessLadderStep, FundEntry, FundSettings } from "@/types/entities";
import type { FundSettingsView, PeriodTotalsView, TruckFundOverview } from "@/types/truck-fund";

function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const DEFAULT_SETTINGS: FundSettingsView = {
  sweep_mode: "off",
  sweep_percent: null,
  sweep_flat_cents: null,
  target_band: null,
  target_cents: null,
};

function toPeriodView(totals: PeriodTotals): PeriodTotalsView {
  return {
    from: totals.from,
    to: totals.to,
    settled_income_cents: totals.settledIncomeCents,
    costs_cents: totals.costsCents,
    settled_net_cents: totals.settledNetCents,
  };
}

export const GET = createApiHandler(async () => {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);
  const week = weekRange(today);
  const month = monthRange(today);
  const fetchFrom = week.from < month.from ? week.from : month.from;
  const fetchTo = week.to > month.to ? week.to : month.to;

  const [
    entriesResult,
    settingsResult,
    loadsResult,
    expensesResult,
    fuelResult,
    maintenanceResult,
    ladderResult,
  ] = await Promise.all([
    supabase
      .from("fund_entries")
      .select("*")
      .is("deleted_at", null)
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("fund_settings").select("*").is("deleted_at", null).limit(1),
    supabase
      .from("loads")
      .select("rate_cents, pickup_date, delivery_date")
      .eq("status", "completed")
      .is("deleted_at", null),
    supabase
      .from("expenses")
      .select("amount_cents, expense_date")
      .is("deleted_at", null)
      .gte("expense_date", fetchFrom)
      .lte("expense_date", fetchTo),
    supabase
      .from("fuel_purchases")
      .select("total_cost_cents, purchased_at")
      .is("deleted_at", null)
      .gte("purchased_at", fetchFrom)
      .lt("purchased_at", dayAfter(fetchTo)),
    supabase
      .from("maintenance_events")
      .select("cost_cents, service_date")
      .is("deleted_at", null)
      .gte("service_date", fetchFrom)
      .lte("service_date", fetchTo),
    supabase.from("business_ladder_steps").select("*").is("deleted_at", null),
  ]);

  for (const result of [
    entriesResult,
    settingsResult,
    loadsResult,
    expensesResult,
    fuelResult,
    maintenanceResult,
    ladderResult,
  ]) {
    if (result.error) throw new Error(result.error.message);
  }

  const entries = (entriesResult.data ?? []) as FundEntry[];
  const settingsRow = ((settingsResult.data ?? []) as FundSettings[])[0];
  const settings: FundSettingsView = settingsRow
    ? {
        sweep_mode: settingsRow.sweep_mode,
        sweep_percent: settingsRow.sweep_percent,
        sweep_flat_cents: settingsRow.sweep_flat_cents,
        target_band: settingsRow.target_band,
        target_cents: settingsRow.target_cents,
      }
    : DEFAULT_SETTINGS;

  const funds = summarizeFunds(entries);
  const progress = computeProgress(
    funds.truck_fund.balanceCents,
    settings.target_band,
    settings.target_cents,
  );

  const loads: PeriodLoadRow[] = (
    (loadsResult.data ?? []) as {
      rate_cents: number | null;
      pickup_date: string | null;
      delivery_date: string | null;
    }[]
  ).map((load) => ({
    rate_cents: load.rate_cents,
    effective_date: load.delivery_date ?? load.pickup_date,
  }));

  const costs: PeriodCostRow[] = [
    ...((expensesResult.data ?? []) as { amount_cents: number | null; expense_date: string }[]).map(
      (row) => ({ amount_cents: row.amount_cents, date: row.expense_date }),
    ),
    ...(
      (fuelResult.data ?? []) as { total_cost_cents: number | null; purchased_at: string }[]
    ).map((row) => ({ amount_cents: row.total_cost_cents, date: row.purchased_at.slice(0, 10) })),
    ...(
      (maintenanceResult.data ?? []) as { cost_cents: number | null; service_date: string }[]
    ).map((row) => ({ amount_cents: row.cost_cents, date: row.service_date })),
  ];

  const weekTotals = aggregatePeriod(loads, costs, week);
  const monthTotals = aggregatePeriod(loads, costs, month);

  const alreadySweptCents = entries
    .filter(
      (entry) =>
        entry.fund_key === "truck_fund" &&
        entry.source === "sweep" &&
        entry.kind === "deposit" &&
        entry.entry_date >= week.from &&
        entry.entry_date <= week.to,
    )
    .reduce((total, entry) => total + entry.amount_cents, 0);

  const rawSuggestion = computeSuggestion({
    settledNetCents: weekTotals.settledNetCents,
    rule: {
      mode: settings.sweep_mode,
      percent: settings.sweep_percent,
      flatCents: settings.sweep_flat_cents,
    },
    alreadySweptCents,
  });

  const accounts = await manualSnapshotAccountVisibility.listAccounts(supabase, today);

  const overview: TruckFundOverview = {
    funds: {
      truck_fund: {
        balance_cents: funds.truck_fund.balanceCents,
        last_entry_date: funds.truck_fund.lastEntryDate,
      },
      business_credit: {
        balance_cents: funds.business_credit.balanceCents,
        last_entry_date: funds.business_credit.lastEntryDate,
      },
      emergency_fund: {
        balance_cents: funds.emergency_fund.balanceCents,
        last_entry_date: funds.emergency_fund.lastEntryDate,
      },
    },
    truck_fund_progress: {
      balance_cents: progress.balanceCents,
      band: progress.band,
      band_low_cents: progress.bandLowCents,
      band_high_cents: progress.bandHighCents,
      target_cents: progress.targetCents,
      percent_of_target: progress.percentOfTarget,
      remaining_cents: progress.remainingCents,
      position: progress.position,
    },
    settings,
    periods: { week: toPeriodView(weekTotals), month: toPeriodView(monthTotals) },
    suggestion: rawSuggestion
      ? { amount_cents: rawSuggestion.amountCents, period: "week", text: rawSuggestion.text }
      : null,
    entries: entries.slice(0, 25),
    ladder: buildLadderView((ladderResult.data ?? []) as BusinessLadderStep[]).map((step) => ({
      step_key: step.stepKey,
      title: step.title,
      what_it_is: step.whatItIs,
      next_action: step.nextAction,
      state: step.state,
      note: step.note,
      unlocked: step.unlocked,
      out_of_order: step.outOfOrder,
    })),
    accounts,
  };

  return NextResponse.json(overview);
});
