// Load recommendations for a driver (design section 3). Pure and EXPLAINABLE: every candidate gets a verdict, points
// per factor, and the reasons. Three factors - money, comfort, home time - weighted by the owner's money_vs_comfort
// dial (0 = all comfort, 1 = all money). A conflict with a stated preference is shown as a conflict, never hidden.
// Recommending does not book anything; it is advice the owner and driver decide on.

import { normalizeState, regionOfState, stateInPlace } from "./regions";

export interface CandidateLoad {
  id: string;
  label: string;
  origin_state?: string | null;
  destination_state?: string | null;
  miles?: number | null;
  rate_cents?: number | null;
  deadhead_miles?: number | null;
  pickup_date?: string | null;
  delivery_date?: string | null;
}

export interface DriverProfile {
  homeState?: string | null;
  preferredRegions: string[];
  avoidRegions: string[];
  minTripMiles?: number | null;
  maxTripMiles?: number | null;
  minCentsPerMile?: number | null;
}

export interface Context {
  /** 0 = all comfort .. 1 = all money. */
  moneyVsComfort: number;
  /** His own average rate per mile (cents) on this candidate's lane, when his history has one. */
  laneAvgCentsPerMile?: (c: CandidateLoad) => number | null;
  /** Days until he is due home (negative = overdue), or null when unknown. */
  homeDueInDays?: number | null;
}

export interface Factor {
  name: "money" | "comfort" | "home time";
  points: number;
  max: number;
  reasons: string[];
}

export type Verdict = "good fit" | "ok" | "weak" | "conflicts with his preferences";

export interface Scored {
  candidate: CandidateLoad;
  total: number;
  verdict: Verdict;
  factors: Factor[];
  conflicts: string[];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Weights sum to 100: money 20-60, comfort 50-20, home time 30-20, by the dial. */
export function weights(moneyVsComfort: number): { money: number; comfort: number; home: number } {
  const m = clamp01(Number.isFinite(moneyVsComfort) ? moneyVsComfort : 0.5);
  const money = Math.round(20 + 40 * m);
  const comfort = Math.round(50 - 30 * m);
  return { money, comfort, home: 100 - money - comfort };
}

export function scoreCandidate(c: CandidateLoad, profile: DriverProfile, ctx: Context): Scored {
  const w = weights(ctx.moneyVsComfort);
  const conflicts: string[] = [];

  // ---- money: effective rate per mile (deadhead counts as miles he drives), against his lane history or minimum
  const money: Factor = { name: "money", points: 0, max: w.money, reasons: [] };
  const paidMiles = c.miles && c.miles > 0 ? c.miles : null;
  if (paidMiles === null || c.rate_cents == null) {
    money.points = w.money * 0.5;
    money.reasons.push("no rate or miles given, so money is a neutral guess - ask for both");
  } else {
    const driven = paidMiles + (c.deadhead_miles ?? 0);
    const effective = c.rate_cents / driven;
    money.reasons.push(`${dollars(effective)}/mile${c.deadhead_miles ? ` counting ${c.deadhead_miles} deadhead miles` : ""} on ${dollars(c.rate_cents)} total`);
    const lane = ctx.laneAvgCentsPerMile?.(c) ?? null;
    const reference = lane ?? profile.minCentsPerMile ?? null;
    if (reference && reference > 0) {
      const ratio = effective / reference;
      money.points = w.money * clamp01((ratio - 0.8) / 0.4); // 80% of the reference scores 0, 120% scores full
      money.reasons.push(lane ? `his own average on this lane is ${dollars(lane)}/mile` : `measured against his minimum of ${dollars(reference)}/mile`);
    } else {
      money.points = w.money * 0.5;
      money.reasons.push("no lane history or minimum to compare against, so money scores neutral");
    }
    if (profile.minCentsPerMile && effective < profile.minCentsPerMile) {
      conflicts.push(`pays ${dollars(effective)}/mile, below his ${dollars(profile.minCentsPerMile)} minimum`);
    }
  }

  // ---- comfort: regions and trip length
  const comfort: Factor = { name: "comfort", points: 0, max: w.comfort, reasons: [] };
  let comfortShare = 0.6;
  const dest = normalizeState(c.destination_state);
  if (dest) {
    if (profile.avoidRegions.some((p) => stateInPlace(dest, p))) {
      comfortShare = 0;
      conflicts.push(`goes to ${dest}, which he avoids`);
      comfort.reasons.push(`destination ${dest} is somewhere he avoids`);
    } else if (profile.preferredRegions.some((p) => stateInPlace(dest, p))) {
      comfortShare = 1;
      comfort.reasons.push(`destination ${dest} is somewhere he prefers`);
    } else comfort.reasons.push(`destination ${dest} is neutral for him`);
  } else comfort.reasons.push("no destination state given - region comfort unknown");
  if (paidMiles !== null) {
    if (profile.maxTripMiles && paidMiles > profile.maxTripMiles) {
      comfortShare = Math.max(0, comfortShare - 0.4);
      conflicts.push(`${paidMiles} miles is over his ${profile.maxTripMiles}-mile limit`);
      comfort.reasons.push(`longer than he likes (${paidMiles} vs ${profile.maxTripMiles})`);
    }
    if (profile.minTripMiles && paidMiles < profile.minTripMiles) {
      comfortShare = Math.max(0, comfortShare - 0.3);
      conflicts.push(`${paidMiles} miles is under his ${profile.minTripMiles}-mile minimum`);
      comfort.reasons.push(`shorter than he likes (${paidMiles} vs ${profile.minTripMiles})`);
    }
  }
  comfort.points = w.comfort * comfortShare;

  // ---- home time: does this load fit when he is due home?
  const home: Factor = { name: "home time", points: 0, max: w.home, reasons: [] };
  let homeShare = 0.6;
  const due = ctx.homeDueInDays;
  const homeState = normalizeState(profile.homeState);
  if (due === null || due === undefined || !homeState || !dest) {
    home.reasons.push(due === null || due === undefined ? "no home-time schedule recorded - neutral" : "needs a home state and a destination to judge");
  } else if (due <= 3) {
    if (dest === homeState) {
      homeShare = 1;
      home.reasons.push(`he is ${due <= 0 ? "overdue for" : "due for"} home time and this ends in ${homeState}`);
    } else if (regionOfState(dest) === regionOfState(homeState)) {
      homeShare = 0.6;
      home.reasons.push(`he is ${due <= 0 ? "overdue" : "due soon"} and this ends in his home region, not at home`);
    } else {
      homeShare = 0.1;
      conflicts.push(`he is ${due <= 0 ? "overdue" : "due"} home and this takes him to ${dest}, away from ${homeState}`);
      home.reasons.push("takes him further from home when he is due");
    }
  } else {
    homeShare = dest === homeState ? 0.8 : 0.6;
    home.reasons.push(`not due home for ${due} days${dest === homeState ? "; this ends at home anyway" : ""}`);
  }
  home.points = w.home * homeShare;

  const factors = [money, comfort, home];
  const total = Math.round(factors.reduce((t, f) => t + f.points, 0));
  const verdict: Verdict = conflicts.length > 0 ? "conflicts with his preferences" : total >= 70 ? "good fit" : total >= 45 ? "ok" : "weak";
  return { candidate: c, total, verdict, factors, conflicts };
}

export function rankCandidates(cs: CandidateLoad[], profile: DriverProfile, ctx: Context): Scored[] {
  return cs.map((c) => scoreCandidate(c, profile, ctx)).sort((a, b) => b.total - a.total || a.candidate.label.localeCompare(b.candidate.label));
}

const ICON: Record<Verdict, string> = { "good fit": "✅", ok: "🟡", weak: "🟠", "conflicts with his preferences": "⚠️" };

export function formatRanking(scored: Scored[], moneyVsComfort: number): string {
  if (scored.length === 0) return "No candidate loads to compare.";
  const w = weights(moneyVsComfort);
  const lines = [`Weights: money ${w.money}, comfort ${w.comfort}, home time ${w.home} (money-vs-comfort dial ${Math.round(moneyVsComfort * 100)}%).`];
  scored.forEach((s, i) => {
    lines.push(`${i + 1}. ${ICON[s.verdict]} ${s.candidate.label} - ${s.total}/100, ${s.verdict}`);
    for (const f of s.factors) lines.push(`   ${f.name} ${Math.round(f.points)}/${f.max}: ${f.reasons.join("; ")}`);
    for (const x of s.conflicts) lines.push(`   ⚠️ ${x}`);
  });
  return lines.join("\n");
}
