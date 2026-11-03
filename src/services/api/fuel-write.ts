// Reliability Unit C (design C.4/C.6, ruling D-04): the fuel write
// preparation hooks wired into the CRUD routes. They run AFTER Zod
// shape validation (create: on the parsed body; update: on the merged
// record) and BEFORE the database write, and they are what makes the
// total a derived figure on the API path:
//
// - gallons precision: more than 3 decimal places is a field-level
//   422, never a silent rounding (C.4(a), C.7.5b);
// - a nonzero adjustment requires a reason (field-level 422);
// - the derived total can never be negative;
// - a client-supplied total_cost_cents is accepted only as the derived
//   echo - any disagreement is a field-level 422 (C.7.5);
// - the stored total is ALWAYS the derived value (base + adjustment),
//   so an edit to gallons/price/adjustment re-derives it even when the
//   patch never mentions the total.
//
// The database enforces the identical invariant (migration 00043), so
// these hooks are the friendly error, not the only guard.

import { deriveFuelTotal, gallonsToMilli } from "@/lib/fuel-math";
import { unprocessableEntity } from "./errors";

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function deriveOrThrow(
  gallons: number,
  pricePerGallonCents: number,
  adjustmentCents: number,
  adjustmentReason: unknown,
): ReturnType<typeof deriveFuelTotal> {
  if (gallonsToMilli(gallons) === null) {
    throw unprocessableEntity("The fuel purchase would be invalid.", [
      { path: "gallons", message: "gallons must have at most 3 decimal places." },
    ]);
  }
  if (
    adjustmentCents !== 0 &&
    !(typeof adjustmentReason === "string" && adjustmentReason.trim().length > 0)
  ) {
    throw unprocessableEntity("The fuel purchase would be invalid.", [
      {
        path: "adjustment_reason",
        message: "adjustment_reason is required when adjustment_cents is not 0.",
      },
    ]);
  }
  const derived = deriveFuelTotal(gallons, pricePerGallonCents, adjustmentCents);
  if (derived.totalCents < 0) {
    throw unprocessableEntity("The fuel purchase would be invalid.", [
      {
        path: "adjustment_cents",
        message: "adjustment_cents would make the total cost negative.",
      },
    ]);
  }
  return derived;
}

function assertEchoAgrees(supplied: unknown, derivedTotalCents: number): void {
  if (supplied !== undefined && supplied !== derivedTotalCents) {
    throw unprocessableEntity("The fuel purchase would be invalid.", [
      {
        path: "total_cost_cents",
        message:
          "total_cost_cents is derived from gallons, price per gallon, and any adjustment - the supplied total does not match it.",
      },
    ]);
  }
}

export function prepareFuelCreate(body: Record<string, unknown>): Record<string, unknown> {
  const gallons = asNumber(body.gallons);
  const price = asNumber(body.price_per_gallon_cents);
  if (gallons === undefined || price === undefined) return body;
  const adjustment = asNumber(body.adjustment_cents) ?? 0;
  const derived = deriveOrThrow(gallons, price, adjustment, body.adjustment_reason);
  assertEchoAgrees(body.total_cost_cents, derived.totalCents);
  return { ...body, adjustment_cents: adjustment, total_cost_cents: derived.totalCents };
}

export function prepareFuelUpdate(
  merged: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const gallons = asNumber(merged.gallons);
  const price = asNumber(merged.price_per_gallon_cents);
  if (gallons === undefined || price === undefined) return patch;
  const adjustment = asNumber(merged.adjustment_cents) ?? 0;
  const derived = deriveOrThrow(gallons, price, adjustment, merged.adjustment_reason);
  assertEchoAgrees(patch.total_cost_cents, derived.totalCents);
  return { ...patch, total_cost_cents: derived.totalCents };
}
