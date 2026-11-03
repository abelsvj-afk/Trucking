// GAP-15 (Fresh-Eyes Register 2026-11-02) — the IFTA worksheet.
//
// Quarter end wants miles by state and fuel by state. What the
// records can honestly produce today:
//  - gallons by state: EXACT, from fuel_purchases.state (GAP-03
//    groundwork, filled by GAP-01's receipt proposals).
//  - total miles: from duty-log odometer spread across the quarter
//    (trustworthy to the extent GAP-09's lane makes odometers
//    trustworthy — flagged in the report until then).
//  - miles by state: only INTRASTATE loads (origin state ==
//    destination state) can be attributed without inventing a
//    split — their load miles land in that state. Interstate load
//    miles are reported as UNALLOCATED, by name, never smeared
//    across states by a formula. Route-geometry accumulation is
//    the Smart Path lane's persistence question; until it exists,
//    the worksheet says what it knows and names what it doesn't.
// Anomalies are the point: states with miles and no fuel, states
// with fuel and no miles, and the quarter's real MPG.

import type { DutyLog, FuelPurchase, Load } from "@/types/entities";

export interface IftaWorksheet {
  quarter: string; // e.g. 2026Q4
  gallonsByState: Record<string, number>;
  totalGallons: number;
  /** Miles attributed to a single state by intrastate loads. */
  milesByState: Record<string, number>;
  /** Interstate load miles that cannot be honestly split by state yet. */
  unallocatedMiles: number;
  /** Odometer spread across the quarter's duty logs (null when fewer than two readings). */
  odometerMiles: number | null;
  /** Odometer miles per gallon (null when either side is unknown). */
  fleetMpg: number | null;
  anomalies: string[];
}

/** "2026Q4" for a YYYY-MM-DD in the quarter; quarters are calendar quarters. */
export function quarterOf(date: string): string {
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}Q${Math.floor((month - 1) / 3) + 1}`;
}

export function quarterRange(quarter: string): { from: string; to: string } {
  const year = Number(quarter.slice(0, 4));
  const q = Number(quarter.slice(5, 6));
  const startMonth = (q - 1) * 3 + 1;
  const from = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  const to = `${year}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

export function buildIftaWorksheet(
  quarter: string,
  input: { fuel: FuelPurchase[]; loads: Load[]; dutyLogs: DutyLog[] },
): IftaWorksheet {
  const { from, to } = quarterRange(quarter);
  const inQuarter = (date: string) => date >= from && date <= to;

  const gallonsByState: Record<string, number> = {};
  let gallonsUnknownState = 0;
  let totalGallons = 0;
  for (const purchase of input.fuel) {
    if (!inQuarter(purchase.purchased_at.slice(0, 10))) continue;
    totalGallons += purchase.gallons;
    if (purchase.state) {
      gallonsByState[purchase.state] = (gallonsByState[purchase.state] ?? 0) + purchase.gallons;
    } else {
      gallonsUnknownState += purchase.gallons;
    }
  }

  const milesByState: Record<string, number> = {};
  let unallocatedMiles = 0;
  for (const load of input.loads) {
    if (load.status !== "completed" || load.miles == null) continue;
    const anchor = load.delivery_date ?? load.pickup_date;
    if (!anchor || !inQuarter(anchor)) continue;
    if (load.origin_state && load.destination_state && load.origin_state === load.destination_state) {
      milesByState[load.origin_state] = (milesByState[load.origin_state] ?? 0) + load.miles;
    } else {
      unallocatedMiles += load.miles;
    }
  }

  const odometers = input.dutyLogs
    .filter((l) => inQuarter(l.started_at.slice(0, 10)))
    .map((l) => l.odometer)
    .filter((o): o is number => typeof o === "number");
  const odometerMiles =
    odometers.length >= 2 ? Math.max(...odometers) - Math.min(...odometers) : null;
  const fleetMpg =
    odometerMiles != null && totalGallons > 0
      ? Math.round((odometerMiles / totalGallons) * 100) / 100
      : null;

  const anomalies: string[] = [];
  for (const state of Object.keys(milesByState)) {
    if (!gallonsByState[state]) {
      anomalies.push(
        `${milesByState[state]} attributed miles in ${state} with no fuel bought there this quarter — right? (Fuel bought over the border is normal; a missing state on a receipt is the other explanation.)`,
      );
    }
  }
  for (const state of Object.keys(gallonsByState)) {
    if (!milesByState[state] && unallocatedMiles === 0) {
      anomalies.push(`Fuel bought in ${state} but no attributed miles there — a pass-through purchase, or a load missing its states?`);
    }
  }
  if (gallonsUnknownState > 0) {
    anomalies.push(
      `${Math.round(gallonsUnknownState * 10) / 10} gallons this quarter have no state recorded — the receipt proposals fill state when the station's state is on the receipt.`,
    );
  }
  if (unallocatedMiles > 0) {
    anomalies.push(
      `${unallocatedMiles} interstate load miles can't be split by state yet — the worksheet lists them honestly instead of guessing a split.`,
    );
  }

  return {
    quarter,
    gallonsByState,
    totalGallons: Math.round(totalGallons * 1000) / 1000,
    milesByState,
    unallocatedMiles,
    odometerMiles,
    fleetMpg,
    anomalies,
  };
}
