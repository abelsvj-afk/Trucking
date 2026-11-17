// Projected pay for a calendar month, and where a goal is reached (docs/design/monthly-income-goal.md,
// owner 2026-11-17). Pure: the loads, the terms lookup and "today" come in; nothing is read here.
// Prices each load with the SAME projection Driver pay and Paychecks use (lib/pay-projection.ts).
// A load that can't be priced is listed with the reason and never counted as $0.

import { projectLoad, type PayTerms, type ProjectableLoad } from "@/lib/pay-projection";

export interface MonthLoad extends ProjectableLoad {
  delivery_date: string | null;
  pickup_date: string | null;
  trip_number?: string | null;
}

export interface MonthRow {
  loadId: string;
  label: string;
  deliveryDate: string;
  earned: boolean;
  lowCents: number | null;
  highCents: number | null;
  note: string;
  /** Running total (low / high) after this load, counting only priced loads. */
  runningLowCents: number;
  runningHighCents: number;
  /** This is the load whose pay first brings the month's low total to the goal. */
  reachesGoal: boolean;
}

export interface MonthIncome {
  month: string;
  rows: MonthRow[];
  earnedLowCents: number;
  earnedHighCents: number;
  bookedLowCents: number;
  bookedHighCents: number;
  totalLowCents: number;
  totalHighCents: number;
  unpricedCount: number;
  goalCents: number | null;
  /** Left to reach the goal on the low end (0 when reached); null without a goal. */
  stillNeededCents: number | null;
  /** The load that reaches the goal, if the booked loads reach it. */
  goalLoad: { loadId: string; label: string; deliveryDate: string } | null;
}

/** "2026-11" for a calendar day. */
export const monthOf = (day: string) => day.slice(0, 7);

export function loadLabel(l: MonthLoad): string {
  return `${l.trip_number ? `Trip ${l.trip_number}, ` : ""}${l.origin} → ${l.destination}`;
}

export function monthIncome(input: {
  month: string;
  today: string;
  loads: MonthLoad[];
  termsFor: (load: MonthLoad) => PayTerms | null;
  goalCents: number | null;
}): MonthIncome {
  const inMonth = input.loads
    .filter((l) => (l.status === "confirmed" || l.status === "completed") && l.delivery_date && monthOf(l.delivery_date) === input.month)
    .sort((a, b) => a.delivery_date!.localeCompare(b.delivery_date!) || loadLabel(a).localeCompare(loadLabel(b)));
  let runLow = 0;
  let runHigh = 0;
  let earnedLow = 0;
  let earnedHigh = 0;
  let unpriced = 0;
  let goalLoad: MonthIncome["goalLoad"] = null;
  const rows: MonthRow[] = inMonth.map((l) => {
    const terms = input.termsFor(l);
    const p = terms ? projectLoad(terms, l) : null;
    const low = p?.lowCents ?? null;
    const high = p?.highCents ?? null;
    const earned = l.status === "completed" || l.delivery_date! <= input.today;
    let reachesGoal = false;
    if (low === null || high === null) {
      unpriced += 1;
    } else {
      const before = runLow;
      runLow += low;
      runHigh += high;
      if (earned) {
        earnedLow += low;
        earnedHigh += high;
      }
      if (input.goalCents !== null && !goalLoad && before < input.goalCents && runLow >= input.goalCents) {
        reachesGoal = true;
        goalLoad = { loadId: l.id, label: loadLabel(l), deliveryDate: l.delivery_date! };
      }
    }
    return {
      loadId: l.id,
      label: loadLabel(l),
      deliveryDate: l.delivery_date!,
      earned,
      lowCents: low,
      highCents: high,
      note: p ? p.note : "No pay terms in force on this date - add them in Settings → Pay terms.",
      runningLowCents: runLow,
      runningHighCents: runHigh,
      reachesGoal,
    };
  });
  return {
    month: input.month,
    rows,
    earnedLowCents: earnedLow,
    earnedHighCents: earnedHigh,
    bookedLowCents: runLow - earnedLow,
    bookedHighCents: runHigh - earnedHigh,
    totalLowCents: runLow,
    totalHighCents: runHigh,
    unpricedCount: unpriced,
    goalCents: input.goalCents,
    stillNeededCents: input.goalCents === null ? null : Math.max(0, input.goalCents - runLow),
    goalLoad,
  };
}
