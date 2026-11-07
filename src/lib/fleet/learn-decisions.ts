// Learning a driver's preferences from his load decisions (design section 3). Pure and interpretable: no model, just
// counts with plain-words evidence. A bucket becomes a CANDIDATE preference only with enough decisions (n >= MIN_N) and a
// clear pattern; candidates are shown with their evidence and become real preferences only after the owner approves.

import { regionOfState, REGION_IDS, type RegionId } from "./regions";

export interface DecisionFeatures {
  decision: "taken" | "passed";
  origin_state?: string | null;
  destination_state?: string | null;
  miles?: number | null;
  rate_cents?: number | null;
  deadhead_miles?: number | null;
}

export interface Candidate {
  key: string;
  value: unknown;
  confidence: number;
  /** Plain words: what the decisions show. */
  evidence: string;
}

export const MIN_N = 4;
export const AVOID_BELOW = 0.25;
export const FAVOR_ABOVE = 0.85;
export const SHORT_MILES = 300;
export const LONG_MILES = 800;

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const rpm = (d: DecisionFeatures) => (d.miles && d.miles > 0 && d.rate_cents != null ? d.rate_cents / d.miles : null);

/** Confidence grows with sample size and with how one-sided the pattern is (0-0.95). */
function confidence(n: number, taken: number): number {
  const share = n === 0 ? 0.5 : taken / n;
  const oneSided = Math.abs(share - 0.5) * 2; // 0 = even split, 1 = unanimous
  return Math.min(0.95, Number(((n / (n + 2)) * oneSided).toFixed(2)));
}

export function learnFromDecisions(decisions: DecisionFeatures[]): Candidate[] {
  const out: Candidate[] = [];

  // destination region
  const avoid: RegionId[] = [];
  const favor: RegionId[] = [];
  const regionEvidence: string[] = [];
  for (const region of REGION_IDS) {
    const rows = decisions.filter((d) => regionOfState(d.destination_state) === region);
    const taken = rows.filter((d) => d.decision === "taken").length;
    if (rows.length < MIN_N) continue;
    const accept = taken / rows.length;
    if (accept <= AVOID_BELOW) {
      avoid.push(region);
      regionEvidence.push(`passed ${rows.length - taken} of ${rows.length} loads going to the ${region}`);
    } else if (accept >= FAVOR_ABOVE) {
      favor.push(region);
      regionEvidence.push(`took ${taken} of ${rows.length} loads going to the ${region}`);
    }
  }
  const regionConf = (rs: RegionId[]) =>
    Math.min(...rs.map((r) => {
      const rows = decisions.filter((d) => regionOfState(d.destination_state) === r);
      return confidence(rows.length, rows.filter((d) => d.decision === "taken").length);
    }));
  if (avoid.length) out.push({ key: "avoid_regions", value: avoid, confidence: regionConf(avoid), evidence: regionEvidence.filter((e) => e.startsWith("passed")).join("; ") });
  if (favor.length) out.push({ key: "preferred_regions", value: favor, confidence: regionConf(favor), evidence: regionEvidence.filter((e) => e.startsWith("took")).join("; ") });

  // trip length
  const withMiles = decisions.filter((d) => d.miles != null && d.miles > 0);
  const long = withMiles.filter((d) => d.miles! > LONG_MILES);
  if (long.length >= MIN_N) {
    const taken = long.filter((d) => d.decision === "taken").length;
    if (taken / long.length <= AVOID_BELOW) {
      out.push({ key: "max_trip_miles", value: LONG_MILES, confidence: confidence(long.length, taken), evidence: `passed ${long.length - taken} of ${long.length} loads over ${LONG_MILES} miles` });
    }
  }
  const short = withMiles.filter((d) => d.miles! < SHORT_MILES);
  if (short.length >= MIN_N) {
    const taken = short.filter((d) => d.decision === "taken").length;
    if (taken / short.length <= AVOID_BELOW) {
      out.push({ key: "min_trip_miles", value: SHORT_MILES, confidence: confidence(short.length, taken), evidence: `passed ${short.length - taken} of ${short.length} loads under ${SHORT_MILES} miles` });
    }
  }

  // the lowest rate he has actually taken, and what he passed below it
  const takenRpm = decisions.filter((d) => d.decision === "taken").map(rpm).filter((x): x is number => x !== null);
  const passedRpm = decisions.filter((d) => d.decision === "passed").map(rpm).filter((x): x is number => x !== null);
  if (takenRpm.length >= MIN_N - 1) {
    const floor = Math.min(...takenRpm);
    const below = passedRpm.filter((r) => r < floor).length;
    if (below >= MIN_N - 1) {
      out.push({
        key: "min_cents_per_mile",
        value: Math.round(floor),
        confidence: confidence(takenRpm.length + below, takenRpm.length),
        evidence: `the lowest rate he has taken is ${money(Math.round(floor))}/mile, and he passed ${below} load${below === 1 ? "" : "s"} paying less`,
      });
    }
  }
  return out;
}
