// Verified state truck rules for Smart Path (docs/design/smart-path-intelligence.md
// §2.3). THIS FILE HOLDS ONLY ROWS SOMEONE VERIFIED AGAINST THE STATE'S OWN SOURCE.
// Claude does not populate legal facts from memory: a state with no row here is
// reported as "no rule on file - check", never as "no restriction".
//
// To add a row: copy the shape below, fill `source_url` with the state's official
// page, set `verified_on` (YYYY-MM-DD) to the day it was checked, and open it for
// review. Rows older than 12 months are shown with their age.

export interface StateTruckRule {
  /** Two-letter state code. */
  state: string;
  /** Plain-words rule as the state states it. */
  summary: string;
  /** Present when the rule can be tested against his truck profile. */
  limit?: { kind: "height_in" | "length_in" | "weight_lbs"; max: number };
  source_url: string;
  /** YYYY-MM-DD the row was checked against source_url. */
  verified_on: string;
}

export const STATE_TRUCK_RULES: StateTruckRule[] = [];
