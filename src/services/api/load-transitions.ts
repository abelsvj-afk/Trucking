// Load status-transition rules (Reliability Unit A / F-016, design
// A.4): loads gain real editing and honest transitions on the existing
// load page. Runs (via the CRUD factory's validateMerged hook) against
// the MERGED record - existing row + patch - so completing a draft only
// requires the fields the final record actually still lacks.
//
// Rules:
// - Confirming (status -> "confirmed") requires the draft-completeness
//   set: pickup_date, delivery_date. A draft missing either is refused
//   with a 422 naming what is missing - never a silent success and
//   never a raw database error. A broker rate (rate_cents) is NOT
//   required: owner ruling 2026-11-10 — his pay is miles × CPM under
//   his employer pay terms (all miles, any kind), so a confirmed load
//   without a rate is valued honestly as an estimate from miles via
//   the load-earnings path, never presented as a recorded rate.
// - Completing (status -> "completed") requires a delivery_date; the
//   "completed" state is what Unit C's revenue recognition keys on, so
//   an undated completion would be a money-truth bug, not a style nit.
// - Every other transition (including -> "draft", -> "cancelled") is
//   allowed; cancelling is a status, never a delete (D-01).

import { unprocessableEntity, type ApiError, type FieldError } from "./errors";

export function loadTransitionRefusal(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
): ApiError | null {
  const from = existing.status;
  const to = merged.status;
  if (to === from || typeof to !== "string") return null;

  if (to === "confirmed") {
    const fields: FieldError[] = [];
    if (!merged.pickup_date) {
      fields.push({ path: "pickup_date", message: "a pickup date is required to confirm this load" });
    }
    if (!merged.delivery_date) {
      fields.push({ path: "delivery_date", message: "a delivery date is required to confirm this load" });
    }
    if (fields.length > 0) {
      return unprocessableEntity(
        `Cannot confirm this load yet — still missing: ${fields.map((f) => f.path).join(", ")}.`,
        fields,
      );
    }
  }

  if (to === "completed" && !merged.delivery_date) {
    return unprocessableEntity("Cannot complete this load — it has no delivery date.", [
      { path: "delivery_date", message: "a delivery date is required to complete this load" },
    ]);
  }

  return null;
}
