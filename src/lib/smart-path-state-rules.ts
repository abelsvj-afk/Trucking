// Smart Path intelligence, Phase 2c (docs/design/smart-path-intelligence.md §2.3):
// match the verified state-rule table against the states a route crosses and his
// truck profile. Pure. Honest by construction: a state with no verified row is
// named as "no rule on file", a rule his truck exceeds is a warning, and a row older
// than STALE_MONTHS shows its age. Advisory - never a legality verdict.

import type { StateTruckRule } from "@/data/state-truck-rules";

export const STALE_MONTHS = 12;

export interface TruckDims {
  height_in: number | null;
  length_in: number | null;
  weight_lbs: number | null;
}

export interface StateRuleLine {
  state: string;
  kind: "exceeds" | "info" | "no_rule_on_file";
  text: string;
  sourceUrl: string | null;
  verifiedOn: string | null;
  old: boolean;
}

const monthsBetween = (fromIso: string, now: Date): number => {
  const from = new Date(`${fromIso}T12:00:00Z`);
  return (now.getUTCFullYear() - from.getUTCFullYear()) * 12 + (now.getUTCMonth() - from.getUTCMonth());
};

export function stateRuleLines(
  statesCrossed: string[],
  rules: StateTruckRule[],
  truck: TruckDims | null,
  now: Date,
): StateRuleLine[] {
  const lines: StateRuleLine[] = [];
  for (const state of [...new Set(statesCrossed)]) {
    const rows = rules.filter((r) => r.state === state);
    if (rows.length === 0) {
      lines.push({ state, kind: "no_rule_on_file", text: `${state}: no truck rule on file for this app - check the state's posted limits.`, sourceUrl: null, verifiedOn: null, old: false });
      continue;
    }
    for (const r of rows) {
      const old = monthsBetween(r.verified_on, now) >= STALE_MONTHS;
      const age = old ? ` (last verified ${r.verified_on} - check it is still current)` : ` (verified ${r.verified_on})`;
      const mine = r.limit && truck ? truck[r.limit.kind] : null;
      const exceeds = r.limit && mine !== null && mine !== undefined && mine > r.limit.max;
      lines.push({
        state,
        kind: exceeds ? "exceeds" : "info",
        text: exceeds
          ? `${state}: ${r.summary} Your truck profile (${mine}) is over the ${r.limit!.max} limit.${age}`
          : `${state}: ${r.summary}${age}`,
        sourceUrl: r.source_url,
        verifiedOn: r.verified_on,
        old,
      });
    }
  }
  return lines;
}
