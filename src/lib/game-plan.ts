// The Gaming System's deterministic core (docs/design/gaming-system.md;
// full spec: the owner's Gaming-System-Design.md). PURE functions only -
// no database, no AI, no clock except the `asOf` the caller passes in.
// The architecture split is deliberate (design §2.4): this module does
// ALL the math; the model only narrates what this module computed, and
// every rendered figure traces to the frozen snapshot, the assumption
// sheet, or arithmetic here.
//
// The honesty fence (design §5) is encoded, not aspirational:
// - trajectories extend SETTLED actuals only (the snapshot builder
//   counts confirmed/completed loads, matching the financial summary);
// - side-income levers exist only with a recorded citation (a research
//   briefing id or one of his recorded skills) AND recorded numbers -
//   no citation, no lever, no exceptions;
// - a candidate plan that requires breaking his Finance Project's
//   STABILIZE rules (leverage before the cushion, an insurance lapse,
//   HOS-illegal weeks) is reported invalid by validateScenarios() and
//   the caller stores it as 'invalid_rules' next to the nearest valid
//   plan this module produces by removing the offending levers.

import { EMERGENCY_FUND_TARGET_CENTS, TRUCK_PRICE_BANDS, type TruckPriceBandKey } from "./truck-fund";

export type GameMetric =
  | "monthly_net_cents"
  | "truck_fund_cents"
  | "business_value_cents"
  | "net_worth_cents";

export type GamePosture = "conservative" | "mixed";

export const GAME_METRICS: GameMetric[] = [
  "monthly_net_cents",
  "truck_fund_cents",
  "business_value_cents",
  "net_worth_cents",
];

export const GAME_METRIC_LABELS: Record<GameMetric, string> = {
  monthly_net_cents: "Monthly net",
  truck_fund_cents: "Truck Fund saved",
  business_value_cents: "Business value (crude)",
  net_worth_cents: "Net worth",
};

// His Finance Project's emergency-cushion floor (design §7 item 5):
// the Gaming System READS this number, never sets it - the same
// constant the Truck Fund page shows as context. If it changes in
// his Finance rules, it changes here and nowhere else.
export const EMERGENCY_CUSHION_FLOOR_CENTS = EMERGENCY_FUND_TARGET_CENTS;

// HOS ceiling for plan demands (design §3.5): the 70-hour / 8-day
// on-duty limit as a weekly equivalent. A scenario whose required
// weekly hours pass this is invalid_rules, full stop - Smart Path's
// legal-first law applies to plans too.
export const HOS_WEEKLY_ON_DUTY_CAP_HOURS = (70 * 7) / 8; // 61.25

// Design §4.1: a maintenance event above this cost re-games the plan.
export const MAINTENANCE_SPIKE_THRESHOLD_CENTS = 50_000; // $500

// Design §2.4 run governance: full re-games per day, counted from
// the game_plan_runs log by the caller.
export const MAX_RE_GAMES_PER_DAY = 4;

// Design §4.2: a re-game whose gap moves less than this is stored
// quietly - versioned, but no user-facing event.
export const DEFAULT_MATERIALITY_PCT = 2;

// Design §3.2 item 6: the S-corp conversation zone (estimate,
// CPA-verify) for trailing-12-month net.
export const S_CORP_ZONE_LOW_CENTS = 4_000_000; // ~$40k

const WEEKS_PER_MONTH = 52 / 12;
const OPEN_ENDED_HORIZON_MONTHS = 24;

// ---------------------------------------------------------------------------
// Snapshot (design §2.2) - assembled by services/game/snapshot.ts from
// the same queries the agent's read tools answer with. Every number
// here is a queried actual; nothing is estimated at this layer.
// ---------------------------------------------------------------------------

export interface SideIncomeCandidate {
  sourceType: "briefing" | "memory";
  sourceId: string;
  label: string;
}

export interface GameSnapshot {
  asOf: string; // YYYY-MM-DD
  // Settled income rate at three windows (design §2.2) - net = settled
  // revenue minus ALL recorded costs in the window, per week.
  netPerWeekCents: { w4: number; w8: number; w12: number };
  grossRevenuePerWeekCents: number;
  loadsPerWeek: number;
  avgNetPerLoadCents: number;
  completedLoads: number;
  // Trailing-90-day cost structure.
  fuelCentsPerMonth: number;
  fuelGallonsPerMonth: number;
  maintenanceCentsPerMonth: number;
  fixedCostsCentsPerMonth: number; // insurance/permits/other expenses
  recentMaintenance: { date: string; costCents: number; description: string }[];
  // Truck Fund state (design §2.2): balances + his ACTUAL savings
  // behavior, not his intended one.
  truckFundBalanceCents: number;
  emergencyFundBalanceCents: number;
  businessCreditBalanceCents: number;
  fundTargetCents: number | null;
  fundTargetBand: TruckPriceBandKey | null;
  sweepRulePct: number | null; // his fund sweep rule, when mode = percent
  actualSavingsRatePct: number; // sweeps / settled net, trailing window
  actualMonthlySavingsCents: number;
  // Capacity (design §2.2): his trailing duty-log pattern.
  driveHoursPerWeek: number;
  onDutyHoursPerWeek: number;
  // The MC-age clock (design §2.2): no authority-activation record
  // exists in the schema yet, so v1 reads not_started and the plan
  // uses the §3.2 aging decision rule instead of a clock.
  mcAge: { status: "not_started" } | { status: "active"; daysSinceActivation: number };
  // Market context: briefings adjust ASSUMPTIONS, never actuals.
  latestBriefings: { id: string; topic: string; title: string; createdAt: string }[];
  // §3.4 fence, candidate side: sources a lever MAY cite. A lever
  // becomes real only when its numbers are recorded against one of
  // these citations on the assumption sheet.
  sideIncomeCandidates: SideIncomeCandidate[];
  // Manual account snapshots (the account-visibility seam): negative
  // balances are known debts; personal-lane balances feed the
  // (still partial) net-worth metric.
  knownDebtsCents: number;
  personalSnapshotCents: number;
  // Data sufficiency (design §2.2): counted and stated, never hidden.
  weeksOfHistory: number;
}

export interface DataSufficiency {
  completedLoads: number;
  weeksOfHistory: number;
  thinData: boolean;
}

export function dataSufficiency(snapshot: GameSnapshot): DataSufficiency {
  return {
    completedLoads: snapshot.completedLoads,
    weeksOfHistory: snapshot.weeksOfHistory,
    thinData: snapshot.completedLoads < 4 || snapshot.weeksOfHistory < 4,
  };
}

// ---------------------------------------------------------------------------
// Assumptions (design §2.3) - every value carries its source. An
// assumption with no source is invalid output.
// ---------------------------------------------------------------------------

export type AssumptionSource = "his_data" | "vision_estimate" | "his_override" | `briefing:${string}`;

export interface AssumptionEntry {
  key: string;
  value: unknown;
  source: AssumptionSource | string;
  adjustable: boolean;
}

export interface SideLever {
  key: string;
  label: string;
  sourceType: "briefing" | "memory";
  sourceId: string; // the cited research_briefings id, or the bot_memories id
  monthlyLowCents: number;
  monthlyHighCents: number;
  hoursPerWeek: number;
  startupCents: number;
  seasonality: string | null;
  startMonth: string | null; // 'YYYY-MM'; null = from the first month
}

export interface ResolvedAssumptions {
  netPerWeekCents: number;
  grossRevenuePerWeekCents: number;
  fuelCentsPerMonth: number;
  fuelGallonsPerMonth: number;
  fuelPriceCentsGal: number; // implied by his data, or his override
  sweepPct: number;
  truckPriceCents: number;
  repairReserveCents: number;
  authorityStartupCents: number;
  insuranceAnnualCents: number;
  factoringPct: number;
  truckFinancingCents: number; // 0 = no new debt in the plan
  authorityActivationMonth: string | null; // his override, 'YYYY-MM'
  sideLevers: SideLever[];
  materialityPct: number;
}

// Vision-doc estimates (design §2.3) - always labeled, always
// rendered with their VERIFY framing until his real quotes replace
// them: authority startup ~$8-20k excl. truck, insurance ~$8-18k/yr.
const DEFAULT_REPAIR_RESERVE_CENTS = 500_000; // $5,000 - estimate
const DEFAULT_AUTHORITY_STARTUP_CENTS = 1_200_000; // $12,000 - estimate, range $8-20k
const DEFAULT_INSURANCE_ANNUAL_CENTS = 1_300_000; // $13,000/yr - estimate, range $8-18k

export interface TargetLike {
  metric: GameMetric;
  targetValueCents: number;
  targetDate: string | null;
  posture: GamePosture;
  postureMixPct: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Resolves the assumption sheet: snapshot defaults first, then
 * persistent overrides (bot_memories kind 'game_assumption'), then
 * one-off what-if overrides - later layers win, and the sheet
 * records which layer each value came from. Side levers are taken
 * ONLY from override layers and ONLY when their citation names a
 * candidate the snapshot surfaced (§3.4 fence, enforced here in
 * code, not in a prompt).
 */
export function buildAssumptions(input: {
  snapshot: GameSnapshot;
  persistentOverrides: Record<string, unknown>;
  oneOffOverrides?: Record<string, unknown>;
}): { sheet: AssumptionEntry[]; values: ResolvedAssumptions } {
  const { snapshot } = input;
  const layers: { source: "his_override"; values: Record<string, unknown> }[] = [
    { source: "his_override", values: input.persistentOverrides },
    ...(input.oneOffOverrides ? [{ source: "his_override" as const, values: input.oneOffOverrides }] : []),
  ];
  const overrideFor = (key: string): unknown => {
    let found: unknown;
    for (const layer of layers) if (key in layer.values) found = layer.values[key];
    return found;
  };

  const sheet: AssumptionEntry[] = [];
  const add = (key: string, value: unknown, source: string, adjustable = true) => {
    sheet.push({ key, value, source, adjustable });
    return value;
  };

  // Pace: the 8-week window is the plan pace (design §2.2's three
  // windows exist so a hot month can't masquerade; the middle window
  // is the honest middle).
  const netPerWeek = add("net_per_week_cents", snapshot.netPerWeekCents.w8, "his_data", false) as number;
  add("gross_revenue_per_week_cents", snapshot.grossRevenuePerWeekCents, "his_data", false);
  add("loads_per_week", snapshot.loadsPerWeek, "his_data", false);

  const impliedFuelPrice =
    snapshot.fuelGallonsPerMonth > 0
      ? Math.round(snapshot.fuelCentsPerMonth / snapshot.fuelGallonsPerMonth)
      : 0;
  const fuelOverride = num(overrideFor("fuel_price_cents_gal"));
  const fuelPrice = add(
    "fuel_price_cents_gal",
    fuelOverride ?? impliedFuelPrice,
    fuelOverride != null ? "his_override" : "his_data",
  ) as number;

  // Sweep: his fund rule when it is a percent rule, else the savings
  // rate his history actually shows (§3.5 prints the delta either way).
  const sweepOverride = num(overrideFor("sweep_pct"));
  const sweepPct = add(
    "sweep_pct",
    sweepOverride ?? snapshot.sweepRulePct ?? snapshot.actualSavingsRatePct,
    sweepOverride != null ? "his_override" : "his_data",
  ) as number;

  const band = snapshot.fundTargetBand ? TRUCK_PRICE_BANDS[snapshot.fundTargetBand] : null;
  const truckPriceDefault = snapshot.fundTargetCents ?? band?.highCents ?? TRUCK_PRICE_BANDS.mid.highCents;
  const truckPriceOverride = num(overrideFor("truck_price_cents"));
  const truckPrice = add(
    "truck_price_cents",
    truckPriceOverride ?? truckPriceDefault,
    truckPriceOverride != null ? "his_override" : snapshot.fundTargetCents != null ? "his_data" : "vision_estimate",
  ) as number;

  const reserveOverride = num(overrideFor("repair_reserve_cents"));
  const reserve = add(
    "repair_reserve_cents",
    reserveOverride ?? DEFAULT_REPAIR_RESERVE_CENTS,
    reserveOverride != null ? "his_override" : "vision_estimate",
  ) as number;

  const startupOverride = num(overrideFor("authority_startup_cents"));
  const startup = add(
    "authority_startup_cents",
    startupOverride ?? DEFAULT_AUTHORITY_STARTUP_CENTS,
    startupOverride != null ? "his_override" : "vision_estimate",
  ) as number;

  const insuranceOverride = num(overrideFor("insurance_annual_cents"));
  const insurance = add(
    "insurance_annual_cents",
    insuranceOverride ?? DEFAULT_INSURANCE_ANNUAL_CENTS,
    insuranceOverride != null ? "his_override" : "vision_estimate",
  ) as number;

  const factoringOverride = num(overrideFor("factoring_pct"));
  const factoring = add("factoring_pct", factoringOverride ?? 0, factoringOverride != null ? "his_override" : "his_data") as number;

  const financingOverride = num(overrideFor("truck_financing_cents"));
  const financing = add(
    "truck_financing_cents",
    financingOverride ?? 0,
    financingOverride != null ? "his_override" : "his_data",
  ) as number;

  const activationRaw = overrideFor("authority_activation_month");
  const activation = add(
    "authority_activation_month",
    typeof activationRaw === "string" ? activationRaw : null,
    activationRaw != null ? "his_override" : "his_data",
  ) as string | null;

  // §3.4 fence: levers arrive only via overrides, and each must cite
  // a candidate the snapshot actually surfaced. A lever citing
  // nothing we can point at does not exist for planning purposes.
  const candidateIds = new Set(snapshot.sideIncomeCandidates.map((c) => `${c.sourceType}:${c.sourceId}`));
  const rawLevers = overrideFor("side_income_levers");
  const sideLevers: SideLever[] = [];
  if (Array.isArray(rawLevers)) {
    for (const raw of rawLevers) {
      const lever = raw as Partial<SideLever>;
      if (
        typeof lever.key === "string" &&
        typeof lever.label === "string" &&
        (lever.sourceType === "briefing" || lever.sourceType === "memory") &&
        typeof lever.sourceId === "string" &&
        candidateIds.has(`${lever.sourceType}:${lever.sourceId}`) &&
        num(lever.monthlyLowCents) != null &&
        num(lever.monthlyHighCents) != null
      ) {
        sideLevers.push({
          key: lever.key,
          label: lever.label,
          sourceType: lever.sourceType,
          sourceId: lever.sourceId,
          monthlyLowCents: Math.max(0, Math.round(lever.monthlyLowCents!)),
          monthlyHighCents: Math.max(lever.monthlyLowCents!, Math.round(lever.monthlyHighCents!)),
          hoursPerWeek: Math.max(0, num(lever.hoursPerWeek) ?? 0),
          startupCents: Math.max(0, Math.round(num(lever.startupCents) ?? 0)),
          seasonality: typeof lever.seasonality === "string" ? lever.seasonality : null,
          startMonth: typeof lever.startMonth === "string" ? lever.startMonth : null,
        });
      }
    }
  }
  add("side_income_levers", sideLevers, "his_override");

  const materialityOverride = num(overrideFor("materiality_pct"));
  const materiality = add(
    "materiality_pct",
    materialityOverride ?? DEFAULT_MATERIALITY_PCT,
    materialityOverride != null ? "his_override" : "vision_estimate",
    false,
  ) as number;

  return {
    sheet,
    values: {
      netPerWeekCents: netPerWeek,
      grossRevenuePerWeekCents: snapshot.grossRevenuePerWeekCents,
      fuelCentsPerMonth: snapshot.fuelCentsPerMonth,
      fuelGallonsPerMonth: snapshot.fuelGallonsPerMonth,
      fuelPriceCentsGal: fuelPrice,
      sweepPct: Math.min(100, Math.max(0, sweepPct)),
      truckPriceCents: truckPrice,
      repairReserveCents: reserve,
      authorityStartupCents: startup,
      insuranceAnnualCents: insurance,
      factoringPct: Math.min(100, Math.max(0, factoring)),
      truckFinancingCents: Math.max(0, financing),
      authorityActivationMonth: activation,
      sideLevers,
      materialityPct: materiality,
    },
  };
}

// ---------------------------------------------------------------------------
// Month helpers - 'YYYY-MM' keys, plain UTC date math (the ET month
// boundary for checkpoints lives in services/game/checkpoint.ts).
// ---------------------------------------------------------------------------

export function monthKeyOf(dateStr: string): string {
  return dateStr.slice(0, 7);
}

export function addMonthsToKey(monthKey: string, months: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const total = y! * 12 + (m! - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function monthsBetweenKeys(fromKey: string, toKey: string): number {
  const [fy, fm] = fromKey.split("-").map(Number);
  const [ty, tm] = toKey.split("-").map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!);
}

// ---------------------------------------------------------------------------
// The scenario engine (design §3) - deterministic month-by-month
// simulation. Same inputs -> same numbers, every time.
// ---------------------------------------------------------------------------

export interface ScenarioConfig {
  sweepPct: number;
  sideLevers: SideLever[];
  truckFinancingCents: number;
  authorityActivationMonth: string | null;
}

export interface MonthPoint {
  month: string; // 'YYYY-MM'
  metricCents: number;
  truckFundCents: number;
  cushionCents: number;
  monthlyNetCents: number;
}

export interface MilestoneSpine {
  truckWindowMonth: string | null; // first month the fund covers price+reserve+startup
  authorityMonth: string | null;
  authorityReason: string | null; // the aging rule's one line, when it moved or blocked activation
  sCorpFlag: boolean;
  sCorpTrailingNetCents: number;
  hireOneReady: false; // §3.2 item 5 is a named later increment - never modeled in v1
}

export interface Demands {
  driveHoursPerWeek: number;
  onDutyHoursPerWeek: number;
  sideHoursPerWeek: number;
  totalHoursPerWeek: number;
  exceedsLegalHours: boolean;
  requiredSweepPct: number;
  actualSweepPct: number;
  sweepDeltaPct: number;
  thinnestCushionMonth: string | null;
  thinnestCushionCents: number;
  cushionBelowFloor: boolean;
}

export interface ScenarioResult {
  key: "current_pace" | "conservative" | "mixed" | "recommended";
  points: MonthPoint[];
  valueAtTargetCents: number;
  shortfallCents: number; // 0 when the scenario clears the target
  milestones: MilestoneSpine;
  demands: Demands;
  truckPurchaseMonth: string | null;
  minCushionCents: number;
  // The fund balance at the authority month BEFORE the purchase
  // spend - what the insurance-lapse check (§5.5) measures against.
  fundAtAuthorityMonthCents: number | null;
}

interface SimState {
  truckFund: number;
  cushion: number;
  purchased: boolean;
  purchaseMonth: string | null;
  truckWindowMonth: string | null;
}

function metricValue(
  metric: GameMetric,
  state: {
    monthlyNetCents: number;
    truckFundCents: number;
    cushionCents: number;
    purchased: boolean;
  },
  snapshot: GameSnapshot,
  values: ResolvedAssumptions,
): number {
  switch (metric) {
    case "monthly_net_cents":
      return state.monthlyNetCents;
    case "truck_fund_cents":
      return state.truckFundCents;
    case "business_value_cents":
      // Deliberately crude (design §1.1): fund balances + the truck
      // once bought - known debts. Labeled crude wherever it renders.
      return (
        state.truckFundCents +
        state.cushionCents +
        snapshot.businessCreditBalanceCents +
        (state.purchased ? values.truckPriceCents : 0) -
        snapshot.knownDebtsCents
      );
    case "net_worth_cents":
      // Partial until Plaid lands (design §1.1): business value plus
      // his hand-recorded personal snapshots - rendered with the
      // partial label, never as a complete picture.
      return metricValue("business_value_cents", state, snapshot, values) + snapshot.personalSnapshotCents;
  }
}

interface EngineInput {
  snapshot: GameSnapshot;
  target: TargetLike;
  values: ResolvedAssumptions;
}

function horizonMonths(snapshot: GameSnapshot, target: TargetLike): { startKey: string; months: string[]; targetKey: string } {
  const startKey = monthKeyOf(snapshot.asOf);
  const targetKey = target.targetDate ? monthKeyOf(target.targetDate) : addMonthsToKey(startKey, OPEN_ENDED_HORIZON_MONTHS - 1);
  const count = Math.max(1, monthsBetweenKeys(startKey, targetKey) + 1);
  const months = Array.from({ length: count }, (_, i) => addMonthsToKey(startKey, i));
  return { startKey, months, targetKey };
}

/**
 * Chooses the authority-activation month under the §3.2 aging rule,
 * enforced here in code: activation is legal only if (a) the truck
 * purchase window falls within ~6 months after it, and (b) the fund
 * covers the truck-side targets plus a full insurance year without
 * the plan dipping the emergency cushion below its floor. An early
 * desired month that fails either test is pushed to the truck
 * window with the reason stated in one line.
 */
function chooseAuthorityMonth(input: {
  desiredMonth: string | null;
  truckWindowMonth: string | null;
  months: string[];
  fundAtMonth: Map<string, number>;
  values: ResolvedAssumptions;
}): { month: string | null; reason: string | null } {
  const { desiredMonth, truckWindowMonth, months, fundAtMonth, values } = input;
  if (!truckWindowMonth) {
    return {
      month: null,
      reason: "No authority activation in this plan: the fund doesn't reach the truck inside the horizon, and the MC clock starts at the truck.",
    };
  }
  const desired = desiredMonth ?? truckWindowMonth;
  const desiredIdx = months.indexOf(desired);
  const truckIdx = months.indexOf(truckWindowMonth);
  const monthsAfter = desiredIdx >= 0 && truckIdx >= 0 ? truckIdx - desiredIdx : 0;

  const fundAtDesired = fundAtMonth.get(desired) ?? 0;
  const needsForTestB = values.truckPriceCents + values.repairReserveCents + values.authorityStartupCents + values.insuranceAnnualCents;
  const testAFails = monthsAfter < 0 || monthsAfter > 6;
  const testBFails = desiredIdx >= 0 && desired < truckWindowMonth && fundAtDesired < needsForTestB;

  if ((testAFails || testBFails) && desired < truckWindowMonth) {
    return {
      month: truckWindowMonth,
      reason: `Authority waits for the truck window (${truckWindowMonth}): aging the MC earlier would cost about $${Math.round(values.insuranceAnnualCents / 100).toLocaleString()}/yr in insurance against loads you can't haul yet - the clock starts at the truck instead.`,
    };
  }
  return { month: desired, reason: null };
}

function simulate(
  input: EngineInput,
  config: ScenarioConfig,
  months: string[],
  targetKey: string,
): ScenarioResult {
  const { snapshot, target, values } = input;
  const state: SimState = {
    truckFund: snapshot.truckFundBalanceCents,
    cushion: snapshot.emergencyFundBalanceCents,
    purchased: false,
    purchaseMonth: null,
    truckWindowMonth: null,
  };

  // Monthly trucking net at pace, with the fuel-price assumption
  // applied as a delta against his actual fuel burn, and factoring
  // (when used at all) as its real cost line - never as early revenue.
  const baseMonthlyNet = Math.round(values.netPerWeekCents * WEEKS_PER_MONTH);
  const impliedFuelPrice =
    values.fuelGallonsPerMonth > 0 ? values.fuelCentsPerMonth / values.fuelGallonsPerMonth : values.fuelPriceCentsGal;
  const fuelDeltaMonthly = Math.round(values.fuelGallonsPerMonth * (values.fuelPriceCentsGal - impliedFuelPrice));
  const factoringCostMonthly = Math.round(
    (values.grossRevenuePerWeekCents * WEEKS_PER_MONTH * values.factoringPct) / 100,
  );
  const truckingNetMonthly = baseMonthlyNet - fuelDeltaMonthly - factoringCostMonthly;

  const truckCrossingCents = values.truckPriceCents + values.repairReserveCents + values.authorityStartupCents;
  const fundByMonth = new Map<string, number>();
  const points: MonthPoint[] = [];
  let minCushion = Number.POSITIVE_INFINITY;
  let thinnestMonth: string | null = null;
  let sideHours = 0;

  // First pass without authority insurance: find the truck window.
  {
    let fund = state.truckFund;
    for (const month of months) {
      const side = config.sideLevers
        .filter((l) => !l.startMonth || l.startMonth <= month)
        .reduce((t, l) => t + l.monthlyLowCents, 0);
      const net = truckingNetMonthly + side;
      const sweep = Math.max(0, net) * (config.sweepPct / 100);
      fund += sweep;
      fundByMonth.set(month, fund);
      if (state.truckWindowMonth == null && fund >= truckCrossingCents) {
        state.truckWindowMonth = month;
      }
    }
  }

  const authority = chooseAuthorityMonth({
    desiredMonth: config.authorityActivationMonth,
    truckWindowMonth: state.truckWindowMonth,
    months,
    fundAtMonth: fundByMonth,
    values,
  });
  const insuranceMonthly = Math.round(values.insuranceAnnualCents / 12);

  // Second pass: the real trajectory, with the purchase spend and
  // the insurance cost line from the activation month.
  state.truckFund = snapshot.truckFundBalanceCents;
  state.cushion = snapshot.emergencyFundBalanceCents;
  for (const month of months) {
    const activeLevers = config.sideLevers.filter((l) => !l.startMonth || l.startMonth <= month);
    sideHours = activeLevers.reduce((t, l) => t + l.hoursPerWeek, 0);
    const sideIncome = activeLevers.reduce((t, l) => t + l.monthlyLowCents, 0);
    const startupCosts = activeLevers
      .filter((l) => (l.startMonth ?? months[0]) === month)
      .reduce((t, l) => t + l.startupCents, 0);
    let net = truckingNetMonthly + sideIncome - startupCosts;
    if (authority.month && month >= authority.month) net -= insuranceMonthly;

    const sweep = Math.max(0, net) * (config.sweepPct / 100);
    state.truckFund += sweep;
    state.cushion += net - sweep;

    if (
      !state.purchased &&
      state.truckWindowMonth != null &&
      month >= state.truckWindowMonth &&
      state.truckFund >= truckCrossingCents
    ) {
      // The purchase spends price + startup filings out of the fund;
      // the repair reserve stays in the fund as the reserve.
      const spend = values.truckPriceCents + values.authorityStartupCents - config.truckFinancingCents;
      state.truckFund -= Math.max(0, spend);
      state.purchased = true;
      state.purchaseMonth = month;
    }

    if (state.cushion < minCushion) {
      minCushion = state.cushion;
      thinnestMonth = month;
    }

    points.push({
      month,
      metricCents: metricValue(
        target.metric,
        {
          monthlyNetCents: net,
          truckFundCents: state.truckFund,
          cushionCents: state.cushion,
          purchased: state.purchased,
        },
        snapshot,
        values,
      ),
      truckFundCents: state.truckFund,
      cushionCents: state.cushion,
      monthlyNetCents: net,
    });
  }

  const atTarget = points.find((p) => p.month === targetKey) ?? points[points.length - 1]!;
  const trailingNet = truckingNetMonthly * 12;

  const totalHours = snapshot.onDutyHoursPerWeek + sideHours;
  const demands: Demands = {
    driveHoursPerWeek: snapshot.driveHoursPerWeek,
    onDutyHoursPerWeek: snapshot.onDutyHoursPerWeek,
    sideHoursPerWeek: sideHours,
    totalHoursPerWeek: totalHours,
    exceedsLegalHours: totalHours > HOS_WEEKLY_ON_DUTY_CAP_HOURS,
    requiredSweepPct: config.sweepPct,
    actualSweepPct: snapshot.actualSavingsRatePct,
    sweepDeltaPct: Math.round((config.sweepPct - snapshot.actualSavingsRatePct) * 10) / 10,
    thinnestCushionMonth: thinnestMonth,
    thinnestCushionCents: minCushion === Number.POSITIVE_INFINITY ? state.cushion : minCushion,
    cushionBelowFloor: (minCushion === Number.POSITIVE_INFINITY ? state.cushion : minCushion) < EMERGENCY_CUSHION_FLOOR_CENTS,
  };

  return {
    key: "conservative", // relabeled by the caller
    points,
    valueAtTargetCents: atTarget.metricCents,
    shortfallCents: Math.max(0, target.targetValueCents - atTarget.metricCents),
    milestones: {
      truckWindowMonth: state.truckWindowMonth,
      authorityMonth: authority.month,
      authorityReason: authority.reason,
      sCorpFlag: trailingNet >= S_CORP_ZONE_LOW_CENTS,
      sCorpTrailingNetCents: trailingNet,
      hireOneReady: false,
    },
    demands,
    truckPurchaseMonth: state.purchaseMonth,
    minCushionCents: demands.thinnestCushionCents,
    fundAtAuthorityMonthCents: authority.month ? (fundByMonth.get(authority.month) ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// The full game (design §3.1/§3.3): three lines always - current
// pace, conservative, mixed - plus the recommended plan, which is
// conservative plus only as much side income as his posture allows.
// ---------------------------------------------------------------------------

export interface LeverContribution {
  key: string;
  label: string;
  contributionCents: number; // at the target month, vs current pace
  source: string; // citation text: the rule, or the lever's §3.4 source
}

export interface GapBlock {
  targetCents: number;
  targetMonth: string;
  currentPaceCents: number;
  conservativeCents: number;
  mixedCents: number;
  recommendedCents: number;
  closers: {
    // When no scenario closes the gap, the only three honest moves
    // (design §3.3): move the date, move the number, or add a lever.
    extraMonthsAtRecommendedPace: number | null;
    reachableAtTargetDateCents: number;
  } | null;
}

export interface GameOutput {
  horizonStartMonth: string;
  targetMonth: string;
  openEnded: boolean;
  scenarios: {
    currentPace: ScenarioResult;
    conservative: ScenarioResult;
    mixed: ScenarioResult;
    recommended: ScenarioResult;
  };
  gap: GapBlock;
  levers: LeverContribution[];
  mixedDeclinedByPosture: boolean;
}

export function gamePlan(input: EngineInput): GameOutput {
  const { snapshot, target, values } = input;
  const { startKey, months, targetKey } = horizonMonths(snapshot, target);

  const paceConfig: ScenarioConfig = {
    sweepPct: snapshot.actualSavingsRatePct,
    sideLevers: [],
    truckFinancingCents: 0,
    authorityActivationMonth: null,
  };
  const conservativeConfig: ScenarioConfig = {
    sweepPct: values.sweepPct,
    sideLevers: [],
    truckFinancingCents: values.truckFinancingCents,
    authorityActivationMonth: values.authorityActivationMonth,
  };
  const mixedConfig: ScenarioConfig = {
    ...conservativeConfig,
    sideLevers: values.sideLevers,
  };

  const currentPace = simulate(input, paceConfig, months, targetKey);
  currentPace.key = "current_pace";
  const conservative = simulate(input, conservativeConfig, months, targetKey);
  conservative.key = "conservative";
  const mixed = simulate(input, mixedConfig, months, targetKey);
  mixed.key = "mixed";

  // Recommended: conservative + side levers admitted only up to the
  // share of the conservative shortfall his posture slider allows
  // (design §1.1 - posture is a permission, not a prediction).
  const allowance = Math.round((conservative.shortfallCents * target.postureMixPct) / 100);
  const admitted: SideLever[] = [];
  let admittedContribution = 0;
  for (const lever of values.sideLevers) {
    const solo = simulate(input, { ...conservativeConfig, sideLevers: [lever] }, months, targetKey);
    const contribution = solo.valueAtTargetCents - conservative.valueAtTargetCents;
    if (contribution > 0 && admittedContribution + contribution <= Math.max(allowance, 0)) {
      admitted.push(lever);
      admittedContribution += contribution;
    }
  }
  const recommended = simulate(input, { ...conservativeConfig, sideLevers: admitted }, months, targetKey);
  recommended.key = "recommended";

  // Lever contributions (design §3.3): arithmetic, from re-running
  // the engine with and without each lever against current pace.
  const levers: LeverContribution[] = [];
  if (values.sweepPct !== snapshot.actualSavingsRatePct) {
    levers.push({
      key: "sweep",
      label: `Sweep ${values.sweepPct}% of settled net to the Truck Fund (your history sustains ${snapshot.actualSavingsRatePct}%)`,
      contributionCents: conservative.valueAtTargetCents - currentPace.valueAtTargetCents,
      source: "his fund rule / savings rate",
    });
  }
  for (const lever of values.sideLevers) {
    const solo = simulate(input, { ...conservativeConfig, sideLevers: [lever] }, months, targetKey);
    levers.push({
      key: `side:${lever.key}`,
      label: lever.label,
      contributionCents: solo.valueAtTargetCents - conservative.valueAtTargetCents,
      source: lever.sourceType === "briefing" ? `research briefing ${lever.sourceId}` : `his recorded skills (memory ${lever.sourceId})`,
    });
  }

  const gapClosed = recommended.shortfallCents <= 0;
  let closers: GapBlock["closers"] = null;
  if (!gapClosed) {
    // Move-the-date: extend the recommended line flat until it
    // reaches the target (bounded search; null = not within 5 years).
    let extraMonths: number | null = null;
    const lastPoint = recommended.points[recommended.points.length - 1]!;
    if (target.metric !== "monthly_net_cents") {
      const monthlyGain =
        recommended.points.length > 1
          ? lastPoint.metricCents - recommended.points[recommended.points.length - 2]!.metricCents
          : 0;
      if (monthlyGain > 0) {
        const needed = Math.ceil((target.targetValueCents - lastPoint.metricCents) / monthlyGain);
        extraMonths = needed <= 60 ? needed : null;
      }
    }
    closers = {
      extraMonthsAtRecommendedPace: extraMonths,
      reachableAtTargetDateCents: recommended.valueAtTargetCents,
    };
  }

  return {
    horizonStartMonth: startKey,
    targetMonth: targetKey,
    openEnded: target.targetDate == null,
    scenarios: { currentPace, conservative, mixed, recommended },
    gap: {
      targetCents: target.targetValueCents,
      targetMonth: targetKey,
      currentPaceCents: currentPace.valueAtTargetCents,
      conservativeCents: conservative.valueAtTargetCents,
      mixedCents: mixed.valueAtTargetCents,
      recommendedCents: recommended.valueAtTargetCents,
      closers,
    },
    levers,
    mixedDeclinedByPosture: target.posture === "conservative" || target.postureMixPct === 0,
  };
}

// ---------------------------------------------------------------------------
// The STABILIZE validity fence (design §5.5). Checked before a plan
// may become 'current'. A violation never gets a warning sticker -
// the caller stores the plan as 'invalid_rules' and stores the
// nearest valid plan (makeNearestValid) as the current one, saying
// what was removed.
// ---------------------------------------------------------------------------

export interface ValidityViolation {
  rule: "leverage_before_cushion" | "insurance_lapse" | "hos_illegal" | "cushion_spend";
  detail: string;
}

export function validateScenarios(input: EngineInput, output: GameOutput): ValidityViolation[] {
  const { values } = input;
  const violations: ValidityViolation[] = [];
  const rec = output.scenarios.recommended;
  const pace = output.scenarios.currentPace;

  // Legal hours only (§3.5/§5.5): the recommended path may not
  // schedule him past the HOS ceiling.
  if (rec.demands.exceedsLegalHours) {
    violations.push({
      rule: "hos_illegal",
      detail: `The plan needs ${rec.demands.totalHoursPerWeek.toFixed(1)} hours/week against the ${HOS_WEEKLY_ON_DUTY_CAP_HOURS.toFixed(2)}-hour legal ceiling (70-hour / 8-day limit).`,
    });
  }

  // Stability before leverage (§5.5): no new debt while the cushion
  // is below its floor at any point on the recommended path.
  if (values.truckFinancingCents > 0 && rec.minCushionCents < EMERGENCY_CUSHION_FLOOR_CENTS) {
    violations.push({
      rule: "leverage_before_cushion",
      detail: `Financing $${Math.round(values.truckFinancingCents / 100).toLocaleString()} of the truck would run the emergency cushion below its $${(EMERGENCY_CUSHION_FLOOR_CENTS / 100).toLocaleString()} floor - stability before leverage.`,
    });
  }

  // No insurance lapse, ever (§3.2/§5.5): authority may only be
  // active where the fund covers a full insurance year and the
  // cushion stays at or above its floor for the year after filing.
  if (rec.milestones.authorityMonth) {
    const startIdx = rec.points.findIndex((p) => p.month === rec.milestones.authorityMonth);
    const yearPoints = rec.points.slice(startIdx, startIdx + 12);
    const fundCoversInsurance =
      (rec.fundAtAuthorityMonthCents ?? 0) >= values.insuranceAnnualCents;
    const cushionHolds = yearPoints.every((p) => p.cushionCents >= 0);
    if (!fundCoversInsurance || !cushionHolds) {
      violations.push({
        rule: "insurance_lapse",
        detail:
          "The authority window in this plan isn't safely covered: the fund at filing doesn't hold a full insurance year, or the cushion goes under water inside the first year - a lapse revokes the authority.",
      });
    }
  }

  // The plan may not SPEND the cushion: if the recommended path
  // drives the cushion below zero where his current pace does not,
  // the plan - not his reality - is what broke the rule (§5.5).
  if (rec.minCushionCents < 0 && pace.minCushionCents >= 0) {
    violations.push({
      rule: "cushion_spend",
      detail: "This path spends the emergency cushion below zero; his current pace does not.",
    });
  }

  return violations;
}

/**
 * The nearest valid plan (design §5.5): re-game with the offending
 * levers removed - financing zeroed, side levers dropped newest-first
 * until the hours are legal - and report what was removed so the
 * stored plan says it out loud. Deterministic: same inputs, same
 * removals.
 */
export function makeNearestValid(
  input: EngineInput,
  violations: ValidityViolation[] = [],
): {
  values: ResolvedAssumptions;
  removed: string[];
} {
  const removed: string[] = [];
  const values: ResolvedAssumptions = {
    ...input.values,
    sideLevers: [...input.values.sideLevers],
  };

  if (violations.some((v) => v.rule === "insurance_lapse") && values.authorityActivationMonth != null) {
    removed.push(
      `early authority activation in ${values.authorityActivationMonth} (removed: the insurance year wasn't safely covered - the aging rule files at the truck instead)`,
    );
    values.authorityActivationMonth = null;
  }

  if (values.truckFinancingCents > 0) {
    removed.push(
      `truck financing of $${Math.round(values.truckFinancingCents / 100).toLocaleString()} (removed: stability before leverage - no new debt while the cushion is under its floor)`,
    );
    values.truckFinancingCents = 0;
  }

  // Drop side levers (newest first) while the total week is illegal.
  const hoursOf = (levers: SideLever[]) =>
    input.snapshot.onDutyHoursPerWeek + levers.reduce((t, l) => t + l.hoursPerWeek, 0);
  while (values.sideLevers.length > 0 && hoursOf(values.sideLevers) > HOS_WEEKLY_ON_DUTY_CAP_HOURS) {
    const dropped = values.sideLevers.pop()!;
    removed.push(`${dropped.label} (removed: its ${dropped.hoursPerWeek} hrs/week pushed the week past the legal hours ceiling)`);
  }

  return { values, removed };
}
