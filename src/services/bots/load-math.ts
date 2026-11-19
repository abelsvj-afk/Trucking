// Dispatch Scout profit math — pure, no I/O.
//
// Prices one board load: pay, $ per loaded mile, $ per ALL miles
// (loaded + deadhead), fuel, and profit, all in integer cents, each
// figure rounded once. The owner judges a load by profit per ALL
// miles and per day, and by the round trip — never by the loaded
// rate alone — so every figure here is built on total miles.
//
// Money is integer cents, decimal-exact, rounded once per figure.
// Per-mile figures use the same rounding as the Auditor
// (auditor.ts centsPerMile: round(pay / miles * 100) / 100) so a
// shortlist built from these numbers passes auditLoadDraft.
//
// Honest limits:
// - Boards do not reliably give miles (TruLOS has no miles column;
//   miles live in Details if at all). This module never invents
//   miles: a load with loaded or deadhead miles missing — or zero
//   or less — cannot be priced and is returned as unpriceable.
//   A true zero deadhead (truck already at the pickup) is also
//   rejected in this cut; that case needs a real routing source
//   before it can be priced honestly.
// - tripDays is 1 when pickup or delivery dates are missing. Per-day
//   figures are a 1-day floor until real pickup/delivery windows
//   arrive from the board reader.
// - exitWarning only knows Florida ("FL") as a dead market in this
//   cut. The list grows from the load ledger (learned) in a later
//   cut; see preferences.ts.

import type { BoardLoad } from "./boards";

export interface PricedLoad {
  load: BoardLoad;
  payCents: number;
  loadedMiles: number;
  deadheadMiles: number;
  totalMiles: number;
  perLoadedMileCents: number;
  perAllMilesCents: number;
  fuelCents: number;
  profitCents: number;
  profitPerAllMileCents: number;
  tripDays: number;
  profitPerDayCents: number;
}

export interface PriceLoadInput {
  load: BoardLoad;
  /** Owner's all-in cost per mile, EXCLUDING fuel (fuel is computed separately from diesel/mpg). */
  costPerMileCents: number;
  dieselCentsPerGallon: number;
  mpg: number;
  deliveryDate?: string | null;
}

/** Same rounding as the Auditor's centsPerMile: cents per mile to two decimals. */
function centsPerMile(payCents: number, miles: number): number {
  return Math.round((payCents / miles) * 100) / 100;
}

/** Days from pickup to delivery, rounded up, minimum 1. Returns 1 when either date is missing or unparseable. */
function tripDaysFor(pickupDate: string | null, deliveryDate: string | null | undefined): number {
  if (!pickupDate || !deliveryDate) return 1;
  const pickup = Date.parse(pickupDate);
  const delivery = Date.parse(deliveryDate);
  if (Number.isNaN(pickup) || Number.isNaN(delivery)) return 1;
  const days = Math.ceil((delivery - pickup) / 86_400_000);
  return Math.max(1, days);
}

export function priceLoad(input: PriceLoadInput): { priced: PricedLoad | null; reason: string | null } {
  const { load } = input;

  if (input.costPerMileCents <= 0) {
    return { priced: null, reason: "Cost per mile is missing or zero — cannot price a load without the owner's cost per mile." };
  }
  if (input.mpg <= 0) {
    return { priced: null, reason: "Fuel economy is missing or zero — cannot price fuel without miles per gallon." };
  }
  if (load.loadedMiles === null || load.loadedMiles <= 0) {
    return { priced: null, reason: "Loaded miles are missing or zero — cannot price a load without miles, and miles are never guessed." };
  }
  if (load.deadheadMiles === null || load.deadheadMiles <= 0) {
    return { priced: null, reason: "Deadhead miles are missing or zero — cannot price a load without the miles to get to the pickup, and miles are never guessed." };
  }

  let payCents: number | null = null;
  if (load.rateCents !== null) {
    payCents = load.rateCents;
  } else if (load.rateCentsPerLoadedMile !== null) {
    payCents = Math.round(load.rateCentsPerLoadedMile * load.loadedMiles);
  }
  if (payCents === null) {
    return { priced: null, reason: "No pay quoted — the load has no flat rate and no per-mile rate." };
  }

  const loadedMiles = load.loadedMiles;
  const deadheadMiles = load.deadheadMiles;
  const totalMiles = Math.round((loadedMiles + deadheadMiles) * 100) / 100;
  const perLoadedMileCents = centsPerMile(payCents, loadedMiles);
  const perAllMilesCents = centsPerMile(payCents, totalMiles);
  const fuelCents = Math.round((totalMiles / input.mpg) * input.dieselCentsPerGallon);
  const operatingCents = Math.round(totalMiles * input.costPerMileCents);
  const profitCents = payCents - operatingCents - fuelCents;
  const profitPerAllMileCents = Math.round((profitCents / totalMiles) * 100) / 100;
  const tripDays = tripDaysFor(load.pickupDate, input.deliveryDate);
  const profitPerDayCents = Math.round(profitCents / tripDays);

  return {
    priced: {
      load,
      payCents,
      loadedMiles,
      deadheadMiles,
      totalMiles,
      perLoadedMileCents,
      perAllMilesCents,
      fuelCents,
      profitCents,
      profitPerAllMileCents,
      tripDays,
      profitPerDayCents,
    },
    reason: null,
  };
}

export function meetsFloor(priced: PricedLoad, floorPerAllMileCents: number): boolean {
  return priced.profitPerAllMileCents >= floorPerAllMileCents;
}

/** Best first: profit per ALL mile, then profit per day, then total pay. Pure and stable — returns a new array. */
export function rankLoads(loads: PricedLoad[]): PricedLoad[] {
  return [...loads].sort(
    (a, b) =>
      b.profitPerAllMileCents - a.profitPerAllMileCents ||
      b.profitPerDayCents - a.profitPerDayCents ||
      b.payCents - a.payCents,
  );
}

/**
 * Plain-words warning when a load delivers into a known dead market
 * with no exit load priced in the same calculation. First cut: the
 * dead-market list is ONLY Florida ("FL") — the playbook rule is
 * "never take a load into Florida without the exit priced in".
 * BoardLoad has no exit field yet, so any Florida delivery warns.
 * The list grows from the ledger (learned) in a later cut.
 */
export function exitWarning(priced: PricedLoad): string | null {
  const destination = priced.load.destination.trim().toUpperCase();
  if (destination === "FL" || destination.endsWith(" FL")) {
    return "Florida delivery with no exit load priced — price the way out before accepting.";
  }
  return null;
}
