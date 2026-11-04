// Abel's fuel writes under Reliability Unit C (migration 00043: the
// stored total must equal round(gallons x price) + adjustment).
//
// Abel hears what a receipt says: gallons and the TOTAL paid. The total
// is the money truth and is kept exactly. The price per gallon is
// derived from it with Unit C's exact integer arithmetic, and any cent
// left over by rounding the price to whole cents is recorded as an
// explicit, reasoned adjustment - never silently absorbed, never a row
// the database invariant would reject. Gallons beyond 3 decimals are
// refused (Unit C's precision contract), not rounded.

import { computeFuelBaseCents, gallonsToMilli } from "@/lib/fuel-math";

export const RECEIPT_ROUNDING_REASON =
  "Receipt total kept exactly; price per gallon rounded to whole cents (Abel, from the receipt).";

export interface ReceiptFuelFields {
  gallons: number;
  price_per_gallon_cents: number;
  adjustment_cents: number;
  adjustment_reason: string | null;
  total_cost_cents: number;
}

export function fuelFieldsFromReceipt(gallons: number, totalCents: number): ReceiptFuelFields {
  const milli = gallonsToMilli(gallons);
  if (milli === null || milli <= 0) {
    throw new Error("Gallons must be more than 0 with at most 3 decimal places - ask him for the pump's gallons as printed.");
  }
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error("The fuel total must be a whole number of cents, 0 or more.");
  }
  // price = round_half_up(total / gallons), in exact integers
  const price = Math.floor((totalCents * 1000 + Math.floor(milli / 2)) / milli);
  const base = computeFuelBaseCents(milli, price);
  const adjustment = totalCents - base;
  return {
    gallons,
    price_per_gallon_cents: price,
    adjustment_cents: adjustment,
    adjustment_reason: adjustment === 0 ? null : RECEIPT_ROUNDING_REASON,
    total_cost_cents: base + adjustment,
  };
}
