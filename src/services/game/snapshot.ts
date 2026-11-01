// Gaming System snapshot builder (design §2.2). Assembles the
// planner's actuals from the SAME tables the agent-omnipresence read
// tools answer with - the planner adds no new read paths and uses no
// remembered figures: every number here came out of a query in this
// run. Settled = confirmed/completed loads placed by
// delivery_date ?? pickup_date, exactly the financial summary's rule,
// because §5.5 counts real (settled) income only.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GameSnapshot, SideIncomeCandidate } from "@/lib/game-plan";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(asOf: string, days: number): string {
  return new Date(new Date(`${asOf}T00:00:00Z`).getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

function tsDaysAgo(asOf: string, days: number): string {
  return new Date(new Date(`${asOf}T00:00:00Z`).getTime() - days * DAY_MS).toISOString();
}

interface LoadRow {
  rate_cents: number | null;
  pickup_date: string | null;
  delivery_date: string | null;
}

function effectiveDate(load: LoadRow): string | null {
  return load.delivery_date ?? load.pickup_date;
}

export async function buildGameSnapshot(
  client: SupabaseClient,
  companyId: string,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<GameSnapshot> {
  const since12w = daysAgo(asOf, 84);
  const since90d = daysAgo(asOf, 90);

  const [
    loadsResult,
    expensesResult,
    fuelResult,
    maintenanceResult,
    entriesResult,
    settingsResult,
    dutyResult,
    briefingsResult,
    memoriesResult,
    snapshotsResult,
    inspectionsResult,
  ] = await Promise.all([
    client
      .from("loads")
      .select("rate_cents, pickup_date, delivery_date")
      .eq("company_id", companyId)
      .in("status", ["confirmed", "completed"])
      .is("deleted_at", null)
      .limit(1000),
    client
      .from("expenses")
      .select("category, amount_cents, expense_date")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("expense_date", since90d)
      .limit(1000),
    client
      .from("fuel_purchases")
      .select("total_cost_cents, gallons, purchased_at")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("purchased_at", tsDaysAgo(asOf, 90))
      .limit(1000),
    client
      .from("maintenance_events")
      .select("cost_cents, service_date, description")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("service_date", since90d)
      .order("service_date", { ascending: false })
      .limit(1000),
    client
      .from("fund_entries")
      .select("fund_key, kind, amount_cents, entry_date, source")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .limit(1000),
    client
      .from("fund_settings")
      .select("sweep_mode, sweep_percent, target_band, target_cents")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .limit(1),
    client
      .from("duty_logs")
      .select("duty_status, started_at")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("started_at", tsDaysAgo(asOf, 28))
      .order("started_at", { ascending: true })
      .limit(500),
    client
      .from("research_briefings")
      .select("id, topic, title, created_at")
      .eq("company_id", companyId)
      .is("dismissed_at", null)
      .order("created_at", { ascending: false })
      .limit(10),
    client
      .from("bot_memories")
      .select("id, kind, content, created_at")
      .eq("company_id", companyId)
      .eq("kind", "fact")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(25),
    client
      .from("account_snapshots")
      .select("institution, account_name, last4, balance_cents, lane, as_of_date")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .limit(200),
    client
      .from("pretrip_inspections")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .is("deleted_at", null),
  ]);

  for (const result of [
    loadsResult,
    expensesResult,
    fuelResult,
    maintenanceResult,
    entriesResult,
    settingsResult,
    dutyResult,
    briefingsResult,
    memoriesResult,
    snapshotsResult,
    inspectionsResult,
  ]) {
    if (result.error) throw new Error(result.error.message);
  }

  const loads = (loadsResult.data ?? []) as LoadRow[];
  const expenses = (expensesResult.data ?? []) as { category: string; amount_cents: number; expense_date: string }[];
  const fuel = (fuelResult.data ?? []) as { total_cost_cents: number; gallons: number; purchased_at: string }[];
  const maintenance = (maintenanceResult.data ?? []) as {
    cost_cents: number | null;
    service_date: string;
    description: string;
  }[];

  const windowNet = (weeks: number) => {
    const from = daysAgo(asOf, weeks * 7);
    const revenue = loads.reduce((t, load) => {
      const d = effectiveDate(load);
      return d != null && d >= from && d <= asOf ? t + (load.rate_cents ?? 0) : t;
    }, 0);
    const expenseCents = expenses
      .filter((e) => e.expense_date >= from)
      .reduce((t, e) => t + e.amount_cents, 0);
    const fuelCents = fuel
      .filter((f) => f.purchased_at.slice(0, 10) >= from)
      .reduce((t, f) => t + f.total_cost_cents, 0);
    const maintenanceCents = maintenance
      .filter((m) => m.service_date >= from)
      .reduce((t, m) => t + (m.cost_cents ?? 0), 0);
    return { revenue, net: revenue - expenseCents - fuelCents - maintenanceCents };
  };

  const w4 = windowNet(4);
  const w8 = windowNet(8);
  const w12 = windowNet(12);
  const settledIn12w = loads.filter((load) => {
    const d = effectiveDate(load);
    return d != null && d >= since12w && d <= asOf;
  }).length;

  const fuelGallons90 = fuel.reduce((t, f) => t + (f.gallons ?? 0), 0);
  const fuelCents90 = fuel.reduce((t, f) => t + f.total_cost_cents, 0);
  const maintenanceCents90 = maintenance.reduce((t, m) => t + (m.cost_cents ?? 0), 0);
  const fixedCents90 = expenses
    .filter((e) => e.category === "insurance" || e.category === "permits" || e.category === "other")
    .reduce((t, e) => t + e.amount_cents, 0);

  // Fund balances from the ledger (computed, never stored - §9's law).
  const entries = (entriesResult.data ?? []) as {
    fund_key: string;
    kind: string;
    amount_cents: number;
    entry_date: string;
    source: string;
  }[];
  const balance = (key: string) =>
    entries
      .filter((e) => e.fund_key === key)
      .reduce((t, e) => t + (e.kind === "deposit" ? e.amount_cents : -e.amount_cents), 0);
  const sweeps90 = entries
    .filter((e) => e.fund_key === "truck_fund" && e.source === "sweep" && e.kind === "deposit" && e.entry_date >= since90d)
    .reduce((t, e) => t + e.amount_cents, 0);
  const settings = ((settingsResult.data ?? []) as {
    sweep_mode: string;
    sweep_percent: number | null;
    target_band: GameSnapshot["fundTargetBand"];
    target_cents: number | null;
  }[])[0];

  // Capacity: duty rows are status STARTS; a status runs until the
  // next one starts (the last runs to the as-of instant).
  const dutyRows = ((dutyResult.data ?? []) as { duty_status: string; started_at: string }[]).map(
    (row) => ({ status: row.duty_status, startMs: new Date(row.started_at).getTime() }),
  );
  const asOfMs = new Date(`${asOf}T23:59:59Z`).getTime();
  let driveMinutes = 0;
  let onDutyMinutes = 0;
  for (const [i, row] of dutyRows.entries()) {
    const endMs = dutyRows[i + 1]?.startMs ?? asOfMs;
    const minutes = Math.max(0, (Math.min(endMs, asOfMs) - row.startMs) / 60000);
    if (row.status === "driving") driveMinutes += minutes;
    if (row.status === "driving" || row.status === "on_duty") onDutyMinutes += minutes;
  }

  const briefings = (briefingsResult.data ?? []) as {
    id: string;
    topic: string;
    title: string;
    created_at: string;
  }[];
  const memories = (memoriesResult.data ?? []) as { id: string; content: string }[];
  const sideIncomeCandidates: SideIncomeCandidate[] = [
    ...briefings.map((b) => ({ sourceType: "briefing" as const, sourceId: b.id, label: b.title })),
    ...memories.map((m) => ({
      sourceType: "memory" as const,
      sourceId: m.id,
      label: m.content.length > 120 ? `${m.content.slice(0, 120)}…` : m.content,
    })),
  ];

  // Account snapshots: latest per account wins.
  const snapshotRows = (snapshotsResult.data ?? []) as {
    institution: string;
    account_name: string;
    last4: string;
    balance_cents: number;
    lane: string;
    as_of_date: string;
  }[];
  const latestByAccount = new Map<string, (typeof snapshotRows)[number]>();
  for (const row of snapshotRows) {
    const key = `${row.institution}|${row.account_name}|${row.last4}`;
    const existing = latestByAccount.get(key);
    if (!existing || row.as_of_date > existing.as_of_date) latestByAccount.set(key, row);
  }
  let knownDebtsCents = 0;
  let personalSnapshotCents = 0;
  for (const row of latestByAccount.values()) {
    if (row.balance_cents < 0) knownDebtsCents += -row.balance_cents;
    else if (row.lane === "personal") personalSnapshotCents += row.balance_cents;
  }

  // Weeks of history: span from the earliest record we can see.
  const earliestCandidates = [
    ...expenses.map((e) => e.expense_date),
    ...fuel.map((f) => f.purchased_at.slice(0, 10)),
    ...loads.map((l) => effectiveDate(l)).filter((d): d is string => d != null),
  ].sort();
  const earliest = earliestCandidates[0];
  const weeksOfHistory = earliest
    ? Math.max(0, Math.floor((new Date(`${asOf}T00:00:00Z`).getTime() - new Date(`${earliest}T00:00:00Z`).getTime()) / (7 * DAY_MS)))
    : 0;

  void inspectionsResult; // inspection counts feed milestone rendering, not the money math (§2.2)

  return {
    asOf,
    netPerWeekCents: {
      w4: Math.round(w4.net / 4),
      w8: Math.round(w8.net / 8),
      w12: Math.round(w12.net / 12),
    },
    grossRevenuePerWeekCents: Math.round(w12.revenue / 12),
    loadsPerWeek: Math.round((settledIn12w / 12) * 100) / 100,
    avgNetPerLoadCents: settledIn12w > 0 ? Math.round(w12.net / settledIn12w) : 0,
    completedLoads: loads.length,
    fuelCentsPerMonth: Math.round(fuelCents90 / 3),
    fuelGallonsPerMonth: Math.round((fuelGallons90 / 3) * 10) / 10,
    maintenanceCentsPerMonth: Math.round(maintenanceCents90 / 3),
    fixedCostsCentsPerMonth: Math.round(fixedCents90 / 3),
    recentMaintenance: maintenance.slice(0, 5).map((m) => ({
      date: m.service_date,
      costCents: m.cost_cents ?? 0,
      description: m.description,
    })),
    truckFundBalanceCents: balance("truck_fund"),
    emergencyFundBalanceCents: balance("emergency_fund"),
    businessCreditBalanceCents: balance("business_credit"),
    fundTargetCents: settings?.target_cents ?? null,
    fundTargetBand: settings?.target_band ?? null,
    sweepRulePct: settings?.sweep_mode === "percent" ? settings.sweep_percent : null,
    actualSavingsRatePct:
      w12.net > 0 ? Math.min(100, Math.round((sweeps90 / w12.net) * 1000) / 10) : 0,
    actualMonthlySavingsCents: Math.round(sweeps90 / 3),
    driveHoursPerWeek: Math.round((driveMinutes / 60 / 4) * 10) / 10,
    onDutyHoursPerWeek: Math.round((onDutyMinutes / 60 / 4) * 10) / 10,
    mcAge: { status: "not_started" },
    latestBriefings: briefings.slice(0, 5).map((b) => ({
      id: b.id,
      topic: b.topic,
      title: b.title,
      createdAt: b.created_at,
    })),
    sideIncomeCandidates,
    knownDebtsCents,
    personalSnapshotCents,
    weeksOfHistory,
  };
}
