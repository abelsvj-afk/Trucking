// Reliability Unit C (design C.4, ruling D-04): the ONE fuel-total
// computation, shared by the API write path, the forms' live display,
// and the tests - so every surface derives the same total the database
// invariant enforces (migration 00043).
//
// The decimal-safe precision contract (C.4 Rev 2), implemented exactly:
// gallons are accepted to 3 decimal places (pumps meter to the
// thousandth) and carried as an integer count of milligallons;
// computed_cents = round_half_up(gallons_milli * price_cents / 1000),
// where the multiplication is exact integer arithmetic and the single
// division rounds half up at this named step and nowhere else. The DB
// computes the same value as round(gallons * price) over numeric(10,3)
// - Postgres numeric multiplication of a 3-dp value by an integer is
// exact and its round() is half-up for non-negative values, so the two
// paths are the same function, not two approximations.
//
// The tripwire this guards (C.7.5b): 2.675 gal x 100c. Exact decimal:
// 267.5 -> 268c. Naive float: 2.675 * 100 = 267.49999... -> 267c.
// Any implementation that drifts into float multiplication fails it.

/** The reason recorded on rows the 00043 migration backfilled. */
export const LEGACY_FUEL_ADJUSTMENT_REASON = "Legacy variance (pre-F-053)";

/**
 * True when the value carries no more precision than the thousandth.
 * Floats like 2.675 are not exact in binary (2.675 * 1000 evaluates to
 * 2674.9999999999995), so the check tolerates representation error far
 * below one milligallon while still rejecting a genuine 4th decimal
 * (2.6755 * 1000 = 2675.5, nowhere near an integer).
 */
export function hasAtMostThreeDecimals(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const milli = value * 1000;
  return Math.abs(milli - Math.round(milli)) < 1e-6;
}

/** Gallons -> integer milligallons, or null when precision is invalid. */
export function gallonsToMilli(gallons: number): number | null {
  if (!hasAtMostThreeDecimals(gallons)) return null;
  return Math.round(gallons * 1000);
}

/**
 * round_half_up(gallons_milli * price_cents / 1000) in exact integer
 * arithmetic (all quantities non-negative, far below 2^53).
 */
export function computeFuelBaseCents(gallonsMilli: number, pricePerGallonCents: number): number {
  const product = gallonsMilli * pricePerGallonCents;
  return Math.floor((product + 500) / 1000);
}

export interface DerivedFuelTotal {
  gallonsMilli: number;
  baseCents: number;
  adjustmentCents: number;
  totalCents: number;
}

/**
 * The derived total for a purchase: base + adjustment. Throws on
 * precision the contract refuses (gallons beyond 3 decimals) rather
 * than silently rounding the input (C.4(a)).
 */
export function deriveFuelTotal(
  gallons: number,
  pricePerGallonCents: number,
  adjustmentCents: number = 0,
): DerivedFuelTotal {
  const gallonsMilli = gallonsToMilli(gallons);
  if (gallonsMilli === null) {
    throw new Error("gallons must have at most 3 decimal places.");
  }
  const baseCents = computeFuelBaseCents(gallonsMilli, pricePerGallonCents);
  return {
    gallonsMilli,
    baseCents,
    adjustmentCents,
    totalCents: baseCents + adjustmentCents,
  };
}
