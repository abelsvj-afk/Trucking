// Mileage propagation + provenance (Image Intelligence design
// §5.3, closing GAP-09): a truck's current_mileage used to be
// whatever a form last typed, with no source and no flow from the
// places miles actually get observed. Now every value that should
// move it goes through ONE helper, every value carries where it
// came from, and the number never moves backwards silently.
//
// Source precedence when several arrive (freshest plausible wins):
// odometer photo > duty-log odometer > maintenance event mileage >
// fuel entry > his word. "Precedence" here is not a ranking war -
// the rule that does the work is simpler and stated on the helper:
// a reading applies when it is >= the recorded one; a lower
// reading NEVER overwrites (it is surfaced as a question by the
// caller instead). Provenance columns land with migration 00045;
// before it, the helper still moves the mileage and says plainly
// that the provenance couldn't be stamped.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "@/services/bot/tool-helpers";

export type MileageSource =
  | "odometer_photo"
  | "duty_log"
  | "maintenance_event"
  | "fuel_entry"
  | "owner_said";

export const MILEAGE_SOURCES: MileageSource[] = [
  "odometer_photo",
  "duty_log",
  "maintenance_event",
  "fuel_entry",
  "owner_said",
];

export const MILEAGE_SOURCE_LABELS: Record<MileageSource, string> = {
  odometer_photo: "a dash photo",
  duty_log: "a duty log entry",
  maintenance_event: "a maintenance record",
  fuel_entry: "a fuel entry",
  owner_said: "his word",
};

/** §4.4's generous bound: past ~1,500 miles per day since the last
 *  reading, a jump gets flagged rather than waved through. */
export const MAX_PLAUSIBLE_MILES_PER_DAY = 1500;

export type OdometerVerdict = "plausible" | "below_current" | "suspicious_jump" | "invalid";

export interface OdometerAssessment {
  verdict: OdometerVerdict;
  /** Miles above the recorded reading, when there is one. */
  delta: number | null;
}

/**
 * The §4.4 odometer sanity rules, in code (never the model's
 * vibes): below the recorded mileage is not staged at all; a jump
 * past the plausible daily rate is staged but flagged; anything
 * else is plausible.
 */
export function assessOdometerReading(input: {
  currentMiles: number | null;
  currentAt: string | null;
  candidateMiles: number;
  now?: Date;
}): OdometerAssessment {
  const { currentMiles, currentAt, candidateMiles } = input;
  if (!Number.isFinite(candidateMiles) || candidateMiles <= 0) {
    return { verdict: "invalid", delta: null };
  }
  if (currentMiles == null) return { verdict: "plausible", delta: null };
  const delta = candidateMiles - currentMiles;
  if (delta < 0) return { verdict: "below_current", delta };
  const now = input.now ?? new Date();
  const sinceMs = currentAt ? now.getTime() - new Date(currentAt).getTime() : 0;
  const days = Math.max(1, sinceMs / 86_400_000);
  if (delta > MAX_PLAUSIBLE_MILES_PER_DAY * days) {
    return { verdict: "suspicious_jump", delta };
  }
  return { verdict: "plausible", delta };
}

export interface PropagateMileageResult {
  applied: boolean;
  /** Why not, when applied is false. */
  reason?: "not_forward" | "no_truck" | "invalid" | "update_failed";
  /** The mileage on the truck before this call (null = none recorded). */
  previousMiles: number | null;
  /** False when migration 00045's provenance columns aren't live yet. */
  provenanceRecorded: boolean;
}

/**
 * The one door every mileage observation walks through. Applies
 * the reading when it moves the truck forward (or matches it);
 * declines - without touching anything - when it would move the
 * number backwards. Callers surface declines in their own words.
 */
export async function propagateMileage(
  client: SupabaseClient,
  companyId: string,
  input: { truckId: string; miles: number; source: MileageSource; at?: Date },
): Promise<PropagateMileageResult> {
  if (!Number.isFinite(input.miles) || input.miles <= 0) {
    return { applied: false, reason: "invalid", previousMiles: null, provenanceRecorded: false };
  }
  const miles = Math.round(input.miles);
  const { data, error } = await client
    .from("trucks")
    .select("id, current_mileage")
    .eq("id", input.truckId)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    return { applied: false, reason: "no_truck", previousMiles: null, provenanceRecorded: false };
  }
  const previous = (data as { current_mileage: number | null }).current_mileage;
  if (previous != null && miles < previous) {
    return { applied: false, reason: "not_forward", previousMiles: previous, provenanceRecorded: false };
  }
  const at = (input.at ?? new Date()).toISOString();
  const stamped = await client
    .from("trucks")
    .update({ current_mileage: miles, current_mileage_source: input.source, current_mileage_at: at })
    .eq("id", input.truckId)
    .eq("company_id", companyId)
    .is("deleted_at", null);
  if (!stamped.error) {
    return { applied: true, previousMiles: previous, provenanceRecorded: true };
  }
  if (isMissingColumnError(stamped.error)) {
    // Pre-00045: move the number, say the stamp didn't happen.
    const bare = await client
      .from("trucks")
      .update({ current_mileage: miles })
      .eq("id", input.truckId)
      .eq("company_id", companyId)
      .is("deleted_at", null);
    if (bare.error) {
      return { applied: false, reason: "update_failed", previousMiles: previous, provenanceRecorded: false };
    }
    return { applied: true, previousMiles: previous, provenanceRecorded: false };
  }
  return { applied: false, reason: "update_failed", previousMiles: previous, provenanceRecorded: false };
}
