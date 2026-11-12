// Lane rate history (owner 2026-11-07; docs/design/fleet-learning-and-driver-questions.md section 6): what HE has been
// paid per mile on a lane, from his own booked and finished loads. Pure. "Is this rate good?" needs a yardstick; this
// is his own history, with the sample size stated - thin history is said to be thin, never dressed up as a market rate.

import { normalizeState } from "@/lib/fleet/regions";
import { formatMoney } from "@/lib/money-format";

export interface LaneLoad {
  id?: string;
  origin?: string | null;
  destination?: string | null;
  origin_state?: string | null;
  destination_state?: string | null;
  rate_cents?: number | null;
  miles?: number | null;
  pickup_date?: string | null;
  delivery_date?: string | null;
}

/** "Tampa, FL" -> "FL"; a bare state ("Florida", "FL") -> its code; else null. */
export function stateOf(text: string | null | undefined): string | null {
  const t = String(text ?? "").trim();
  const tail = /,\s*([A-Za-z]{2})\.?$/.exec(t);
  return normalizeState(tail ? tail[1] : t);
}

const loadState = (l: LaneLoad, side: "origin" | "destination") => normalizeState(side === "origin" ? l.origin_state : l.destination_state) ?? stateOf(side === "origin" ? l.origin : l.destination);
const rpm = (l: LaneLoad) => (l.rate_cents != null && l.miles && l.miles > 0 ? l.rate_cents / l.miles : null);
const dayOf = (l: LaneLoad) => l.delivery_date ?? l.pickup_date ?? "";

export interface LaneStats {
  n: number;
  avgCents: number | null;
  medianCents: number | null;
  minCents: number | null;
  maxCents: number | null;
  /** Newest first, up to 3. */
  recent: { day: string; centsPerMile: number; label: string }[];
  /** Average of the newest 3 minus the overall average, in cents; null with fewer than 4 loads. */
  trendCents: number | null;
}

/** Statistics over the loads that match the lane (origin state -> destination state; either side may be null = any). */
export function laneStats(loads: LaneLoad[], origin: string | null, destination: string | null): LaneStats {
  const o = origin ? stateOf(origin) : null;
  const d = destination ? stateOf(destination) : null;
  const rows = loads
    .filter((l) => (o === null || loadState(l, "origin") === o) && (d === null || loadState(l, "destination") === d))
    .map((l) => ({ l, r: rpm(l) }))
    .filter((x): x is { l: LaneLoad; r: number } => x.r !== null)
    .sort((a, b) => dayOf(b.l).localeCompare(dayOf(a.l)));
  if (rows.length === 0) return { n: 0, avgCents: null, medianCents: null, minCents: null, maxCents: null, recent: [], trendCents: null };
  const values = rows.map((x) => x.r).sort((a, b) => a - b);
  const avg = values.reduce((t, v) => t + v, 0) / values.length;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
  const newest3 = rows.slice(0, 3).map((x) => x.r);
  return {
    n: rows.length,
    avgCents: Math.round(avg),
    medianCents: Math.round(median),
    minCents: Math.round(values[0]!),
    maxCents: Math.round(values[values.length - 1]!),
    recent: rows.slice(0, 3).map((x) => ({ day: dayOf(x.l), centsPerMile: Math.round(x.r), label: `${x.l.origin ?? "?"} → ${x.l.destination ?? "?"}` })),
    trendCents: rows.length >= 4 ? Math.round(newest3.reduce((t, v) => t + v, 0) / newest3.length - avg) : null,
  };
}

const usd = (c: number) => formatMoney(c);

export function formatLaneStats(origin: string | null, destination: string | null, s: LaneStats): string {
  const lane = `${origin ? (stateOf(origin) ?? origin) : "anywhere"} → ${destination ? (stateOf(destination) ?? destination) : "anywhere"}`;
  if (s.n === 0) return `No priced loads of his on ${lane} yet, so I have no history of his own to judge a rate against.`;
  const thin = s.n < 3 ? ` That is only ${s.n} load${s.n === 1 ? "" : "s"} - too thin to call a market rate.` : "";
  const lines = [
    `His own history on ${lane}: ${s.n} load${s.n === 1 ? "" : "s"}, average ${usd(s.avgCents!)}/mile (median ${usd(s.medianCents!)}, range ${usd(s.minCents!)}-${usd(s.maxCents!)}).${thin}`,
    ...s.recent.map((r) => `  ${r.day || "undated"}: ${usd(r.centsPerMile)}/mile (${r.label})`),
  ];
  if (s.trendCents !== null && Math.abs(s.trendCents) >= 5) lines.push(`Recent loads are running ${usd(Math.abs(s.trendCents))}/mile ${s.trendCents > 0 ? "above" : "below"} his overall average on this lane.`);
  lines.push("This is HIS history, not the market - brokers' current rates can differ.");
  return lines.join("\n");
}

/** For recommendations: his average rate per mile on a candidate's lane, or null with fewer than 2 loads of history. */
export function laneAverager(loads: LaneLoad[]): (c: { origin_state?: string | null; destination_state?: string | null }) => number | null {
  return (c) => {
    const o = normalizeState(c.origin_state);
    const d = normalizeState(c.destination_state);
    if (!o || !d) return null;
    const s = laneStats(loads, o, d);
    return s.n >= 2 ? s.avgCents : null;
  };
}
