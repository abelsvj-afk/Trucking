// Truck Fund + money visibility (docs/design/driver-mvp.md §9). All the
// math worth getting wrong lives here as pure functions, unit-tested
// without a database - same reasoning as lib/hos.ts and
// lib/maintenance-schedule.ts. The standing law for everything in this
// file: the app reads, computes, and suggests - it NEVER moves money.

export type FundKey = "truck_fund" | "business_credit" | "emergency_fund";
export type FundEntryKind = "deposit" | "withdrawal";
export type MoneyLane = "business" | "personal";
export type FundEntrySource = "manual" | "sweep";
export type TruckPriceBandKey = "budget" | "mid" | "upper";
export type SweepMode = "off" | "percent" | "flat";
export type LadderStepKey =
  | "ein"
  | "business_bank"
  | "duns"
  | "tradelines"
  | "paydex"
  | "real_credit";
export type LadderStepState = "not_started" | "in_progress" | "done";

// The vision doc §2's first-truck price bands. ESTIMATES from
// late-2026 used-truck market guides - labeled as estimates on every
// surface that shows them; they are ballparks to verify against live
// listings when he's actually shopping, not prices.
export const TRUCK_PRICE_BANDS: Record<
  TruckPriceBandKey,
  { label: string; lowCents: number; highCents: number }
> = {
  budget: { label: "Budget tier", lowCents: 2_000_000, highCents: 4_000_000 },
  mid: { label: "Mid-range", lowCents: 4_000_000, highCents: 7_500_000 },
  upper: { label: "Upper used", lowCents: 7_500_000, highCents: 12_000_000 },
};

// His Finance Project's emergency-fund target, shown as CONTEXT on
// the emergency bucket (vision §8: the app operationalizes his
// existing buckets; his Finance rules decide, the app displays).
export const EMERGENCY_FUND_TARGET_CENTS = 1_000_000; // $10,000

export const FUND_LABELS: Record<FundKey, string> = {
  truck_fund: "Truck Fund",
  business_credit: "Business-credit bucket",
  emergency_fund: "Emergency fund",
};

export function formatDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

// --- Fund ledger -----------------------------------------------------------

export interface FundEntryLike {
  fund_key: FundKey;
  kind: FundEntryKind;
  amount_cents: number;
  entry_date: string;
  source: FundEntrySource;
}

export interface FundSummary {
  balanceCents: number;
  lastEntryDate: string | null;
}

export function summarizeFunds(entries: FundEntryLike[]): Record<FundKey, FundSummary> {
  const funds: Record<FundKey, FundSummary> = {
    truck_fund: { balanceCents: 0, lastEntryDate: null },
    business_credit: { balanceCents: 0, lastEntryDate: null },
    emergency_fund: { balanceCents: 0, lastEntryDate: null },
  };
  for (const entry of entries) {
    const fund = funds[entry.fund_key];
    fund.balanceCents += entry.kind === "deposit" ? entry.amount_cents : -entry.amount_cents;
    if (fund.lastEntryDate == null || entry.entry_date > fund.lastEntryDate) {
      fund.lastEntryDate = entry.entry_date;
    }
  }
  return funds;
}

// --- Truck Fund progress ----------------------------------------------------

export type BandPosition = "below_band" | "in_band" | "past_band";

export interface TruckFundProgress {
  balanceCents: number;
  band: TruckPriceBandKey | null;
  bandLowCents: number | null;
  bandHighCents: number | null;
  // Effective target: the custom override when set, else the band's
  // top, else null (no target chosen yet - progress is then just a
  // balance, and the UI says so rather than inventing a goal).
  targetCents: number | null;
  percentOfTarget: number | null;
  remainingCents: number | null;
  position: BandPosition | null;
}

export function computeProgress(
  balanceCents: number,
  bandKey: TruckPriceBandKey | null,
  targetCentsOverride: number | null,
): TruckFundProgress {
  const band = bandKey ? TRUCK_PRICE_BANDS[bandKey] : null;
  const targetCents = targetCentsOverride ?? band?.highCents ?? null;

  const percentOfTarget =
    targetCents != null && targetCents > 0
      ? Math.round((balanceCents / targetCents) * 1000) / 10
      : null;
  const remainingCents = targetCents != null ? Math.max(0, targetCents - balanceCents) : null;
  const position: BandPosition | null = band
    ? balanceCents < band.lowCents
      ? "below_band"
      : balanceCents <= band.highCents
        ? "in_band"
        : "past_band"
    : null;

  return {
    balanceCents,
    band: bandKey,
    bandLowCents: band?.lowCents ?? null,
    bandHighCents: band?.highCents ?? null,
    targetCents,
    percentOfTarget,
    remainingCents,
    position,
  };
}

// --- Periods ----------------------------------------------------------------

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Mon-Sun week containing `date` (YYYY-MM-DD), UTC - the same
// timezone convention the financial summary already uses.
export function weekRange(date: string): { from: string; to: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const from = addDays(date, -daysSinceMonday);
  return { from, to: addDays(from, 6) };
}

export function monthRange(date: string): { from: string; to: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  return { from, to };
}

// --- Settled income / net per period ----------------------------------------

// Rows are normalized by the caller: loads arrive with the
// financial-summary placement rule already applied (delivery_date,
// falling back to pickup_date) and ONLY status 'completed' - settled
// means the work is done, per §9.3. Costs arrive with a plain date
// (fuel's purchased_at timestamptz is sliced to its UTC date by the
// caller, matching the financial summary's day handling).
export interface PeriodLoadRow {
  rate_cents: number | null;
  effective_date: string | null;
}

export interface PeriodCostRow {
  amount_cents: number | null;
  date: string;
}

export interface PeriodTotals {
  from: string;
  to: string;
  settledIncomeCents: number;
  costsCents: number;
  settledNetCents: number;
}

export function aggregatePeriod(
  loads: PeriodLoadRow[],
  costs: PeriodCostRow[],
  range: { from: string; to: string },
): PeriodTotals {
  const settledIncomeCents = loads.reduce((total, load) => {
    if (load.effective_date == null) return total;
    if (load.effective_date < range.from || load.effective_date > range.to) return total;
    return total + (load.rate_cents ?? 0);
  }, 0);
  const costsCents = costs.reduce((total, cost) => {
    if (cost.date < range.from || cost.date > range.to) return total;
    return total + (cost.amount_cents ?? 0);
  }, 0);
  return {
    from: range.from,
    to: range.to,
    settledIncomeCents,
    costsCents,
    settledNetCents: settledIncomeCents - costsCents,
  };
}

// --- The sweep suggestion -----------------------------------------------------

export interface SweepRule {
  mode: SweepMode;
  percent: number | null;
  flatCents: number | null;
}

export interface SweepSuggestion {
  amountCents: number;
  text: string;
}

// Null whenever there is honestly nothing to suggest: no rule set
// (the default), a rule whose value is missing, no positive settled
// net, or sweep entries already recorded this period covering what
// the rule would send (so recording a suggestion never re-suggests
// the same dollars). Percent rounds DOWN - the app never suggests
// moving more than the rule's share.
export function computeSuggestion(input: {
  settledNetCents: number;
  rule: SweepRule;
  alreadySweptCents: number;
}): SweepSuggestion | null {
  const { settledNetCents, rule, alreadySweptCents } = input;
  if (rule.mode === "off") return null;
  if (settledNetCents <= 0) return null;

  let ruleAmount: number;
  if (rule.mode === "percent") {
    if (rule.percent == null) return null;
    ruleAmount = Math.floor((settledNetCents * rule.percent) / 100);
  } else {
    if (rule.flatCents == null) return null;
    ruleAmount = rule.flatCents;
  }

  const amountCents = ruleAmount - alreadySweptCents;
  if (amountCents <= 0) return null;

  return {
    amountCents,
    text: `${formatDollars(settledNetCents)} settled this week. Your rule sends ${formatDollars(amountCents)} to the Truck Fund.`,
  };
}

// --- Account snapshot staleness ----------------------------------------------

export type SnapshotStalenessLevel = "current" | "aging" | "stale";

export interface SnapshotStaleness {
  level: SnapshotStalenessLevel;
  ageDays: number;
  label: string;
}

// A snapshot is a balance as of a date, never a live figure - the
// label says how old that truth is. Thresholds: a week is "current"
// for a hand-entered balance, a month is the outer edge of "aging,"
// past that the honest word is "stale." A snapshot dated in the
// future (clock/entry slip) reads as current rather than nonsense.
export function snapshotStaleness(asOfDate: string, today: string): SnapshotStaleness {
  const msPerDay = 24 * 60 * 60 * 1000;
  const ageDays = Math.max(
    0,
    Math.round(
      (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${asOfDate}T00:00:00Z`).getTime()) /
        msPerDay,
    ),
  );
  if (ageDays <= 7) return { level: "current", ageDays, label: "Current" };
  if (ageDays <= 30) return { level: "aging", ageDays, label: "Aging" };
  return { level: "stale", ageDays, label: "Stale — may be out of date" };
}

// --- Business finance ladder (vision §8) --------------------------------------

export interface LadderStepDef {
  stepKey: LadderStepKey;
  title: string;
  whatItIs: string;
  nextAction: string;
}

// Static knowledge, in the vision's order - each rung makes the next
// one possible. Items the vision flags ⚠️ VERIFY stay labeled as
// verify-before-relying in the copy; programs and scoring details
// change, and the ladder teaches the order, not gospel specifics.
export const BUSINESS_LADDER_STEPS: LadderStepDef[] = [
  {
    stepKey: "ein",
    title: "EIN on file",
    whatItIs:
      "Your LLC's federal tax ID — free from the IRS, and the number every business account application asks for first.",
    nextAction:
      "Confirm the LLC's EIN is on record and matches what the bank has. Never pay a website for one.",
  },
  {
    stepKey: "business_bank",
    title: "Business bank account",
    whatItIs:
      "An account in the LLC's name, under its EIN, that business money alone flows through. No business credit survives commingled money.",
    nextAction:
      "Open it if you haven't, and route every trucking dollar through it from now on.",
  },
  {
    stepKey: "duns",
    title: "DUNS number",
    whatItIs:
      "Dun & Bradstreet's identifier for your company — how the business credit bureaus find and file you.",
    nextAction:
      "Register (free — verify the current process at dnb.com) and make the company name, address, and phone match exactly across Sunbiz, the EIN record, the bank, and DUNS.",
  },
  {
    stepKey: "tradelines",
    title: "Starter tradelines that report",
    whatItIs:
      "Small accounts designed for new businesses — vendor net-30 terms, a secured or starter business card — that report your payments to the bureaus.",
    nextAction:
      "Open one or two, verify each actually reports payments before counting on it (programs change), buy what the business needs, and pay early.",
  },
  {
    stepKey: "paydex",
    title: "Paydex score building",
    whatItIs:
      "Dun & Bradstreet's payment score for your company. Paying on time or early builds it; 80+ is the conventional good zone (rule of thumb — verify current scoring).",
    nextAction:
      "Never miss a due date on a reporting account, and keep notes here on which tradelines report and when payments post.",
  },
  {
    stepKey: "real_credit",
    title: "First real business credit",
    whatItIs:
      "Business cards and credit lines in the company's own name, priced off the history the rungs below built — less dependence on your personal credit over time.",
    nextAction:
      "Apply once reporting tradelines and months of clean history exist. Log every personal guarantee you sign (normal early on) so you always know your real exposure.",
  },
];

export interface LadderStepView extends LadderStepDef {
  state: LadderStepState;
  note: string | null;
  // Unlocked = every earlier rung is done. The first rung is always
  // unlocked.
  unlocked: boolean;
  // Started/done while an earlier rung isn't done - allowed (he may
  // already hold an EIN from before the app) but flagged, per §9.4.
  outOfOrder: boolean;
}

export function buildLadderView(
  rows: { step_key: LadderStepKey; state: LadderStepState; note: string | null }[],
): LadderStepView[] {
  const byKey = new Map(rows.map((row) => [row.step_key, row]));
  let allPreviousDone = true;
  return BUSINESS_LADDER_STEPS.map((def) => {
    const row = byKey.get(def.stepKey);
    const state = row?.state ?? "not_started";
    const view: LadderStepView = {
      ...def,
      state,
      note: row?.note ?? null,
      unlocked: allPreviousDone,
      outOfOrder: !allPreviousDone && state !== "not_started",
    };
    if (state !== "done") allPreviousDone = false;
    return view;
  });
}

export function isLadderStepKey(value: string): value is LadderStepKey {
  return BUSINESS_LADDER_STEPS.some((step) => step.stepKey === value);
}
