// Shape of the computed GET /api/v1/truck-fund aggregate
// (docs/api-contracts.md). Not a stored row (docs/schemas.md), so it
// lives outside entities.ts - same reasoning as financial-summary.ts.
// Field names follow the API's snake_case convention; the pure math
// in lib/truck-fund.ts uses camelCase and the route maps between
// them.

import type { BandPosition, FundKey, LadderStepState, TruckPriceBandKey } from "@/lib/truck-fund";
import type { AccountSnapshot, FundEntry, FundSettings } from "@/types/entities";

export interface FundSummaryView {
  balance_cents: number;
  last_entry_date: string | null;
}

export interface TruckFundProgressView {
  balance_cents: number;
  band: TruckPriceBandKey | null;
  band_low_cents: number | null;
  band_high_cents: number | null;
  target_cents: number | null;
  percent_of_target: number | null;
  remaining_cents: number | null;
  position: BandPosition | null;
}

export type FundSettingsView = Pick<
  FundSettings,
  "sweep_mode" | "sweep_percent" | "sweep_flat_cents" | "target_band" | "target_cents"
>;

export interface PeriodTotalsView {
  from: string;
  to: string;
  settled_income_cents: number;
  costs_cents: number;
  settled_net_cents: number;
}

export interface SweepSuggestionView {
  amount_cents: number;
  period: "week";
  text: string;
}

export interface LadderStepView {
  step_key: string;
  title: string;
  what_it_is: string;
  next_action: string;
  state: LadderStepState;
  note: string | null;
  unlocked: boolean;
  out_of_order: boolean;
}

export interface SnapshotStalenessView {
  level: "current" | "aging" | "stale";
  age_days: number;
  label: string;
}

// An account as the §9.5 visibility seam returns it: the snapshot's
// own fields plus where the data came from and how old its truth is.
export interface AccountView extends AccountSnapshot {
  source: "manual_snapshot";
  staleness: SnapshotStalenessView;
}

export interface TruckFundOverview {
  funds: Record<FundKey, FundSummaryView>;
  truck_fund_progress: TruckFundProgressView;
  settings: FundSettingsView;
  periods: { week: PeriodTotalsView; month: PeriodTotalsView };
  suggestion: SweepSuggestionView | null;
  entries: FundEntry[];
  ladder: LadderStepView[];
  accounts: AccountView[];
}
