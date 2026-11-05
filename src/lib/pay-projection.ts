// Projected pay that adds up as loads are added (owner request 2026-11-05).
// Pure. Computed from the owner's pay terms (employer_pay_profiles) and each
// load's miles - never from a guess:
//  - the miles basis he pinned decides WHICH miles are paid (loaded / all);
//  - "practical" miles are carrier-computed, so the app cannot project them;
//  - while the basis is UNSET it does not pick one: when the load's loaded and
//    all-miles figures differ it shows the RANGE (loaded-only .. all miles) and
//    says so in plain words; when only a single mileage figure exists it shows
//    that one number and says which figure it counted and that the basis is
//    not set;
//  - a load without the miles it needs is "can't project yet", with the
//    reason - never a substituted number.
// This is the gross pay under his stated rate. No tax, fuel or deduction math,
// and it is a projection until the carrier's settlement says otherwise.

export interface PayTerms {
  employer_name: string;
  rate_cents_per_mile: number;
  mile_basis: "loaded" | "all" | "practical" | null;
}

export interface ProjectableLoad {
  id: string;
  origin: string;
  destination: string;
  status: string;
  /** The integer total miles on the load. */
  miles: number | null;
  loaded_miles?: number | null;
  deadhead_miles?: number | null;
  pickup_date: string | null;
  delivery_date: string | null;
}

export type ProjectionKind = "exact" | "range" | "assumed" | "unavailable";

export interface LoadProjection {
  loadId: string;
  kind: ProjectionKind;
  /** Low and high of the projection in cents; equal unless kind is "range". Null when unavailable. */
  lowCents: number | null;
  highCents: number | null;
  /** The miles figure(s) counted, in words ("900.5 loaded miles"). */
  counted: string | null;
  /** Plain-words note: what was assumed or why it can't be projected. */
  note: string;
}

const money = (rate: number, miles: number) => Math.round(rate * miles);
const mi = (n: number) => `${Number(n.toFixed(2)).toLocaleString("en-US")}`;

export function projectLoad(terms: PayTerms, load: ProjectableLoad): LoadProjection {
  const rate = terms.rate_cents_per_mile;
  const loaded = load.loaded_miles ?? null;
  const dead = load.deadhead_miles ?? null;
  const allMiles = loaded !== null && dead !== null ? loaded + dead : load.miles ?? null;
  const base = { loadId: load.id };

  if (terms.mile_basis === "practical") {
    return { ...base, kind: "unavailable", lowCents: null, highCents: null, counted: null,
      note: "Your pay counts practical miles, which the carrier computes — the app can't project them. Use the settlement." };
  }
  if (terms.mile_basis === "loaded") {
    if (loaded === null) {
      return { ...base, kind: "unavailable", lowCents: null, highCents: null, counted: null,
        note: "Pay is on loaded miles and this load has no loaded-miles figure yet." };
    }
    const c = money(rate, loaded);
    return { ...base, kind: "exact", lowCents: c, highCents: c, counted: `${mi(loaded)} loaded miles`, note: "Loaded miles only (your pay terms)." };
  }
  if (terms.mile_basis === "all") {
    if (allMiles === null) {
      return { ...base, kind: "unavailable", lowCents: null, highCents: null, counted: null,
        note: "Pay is on all miles and this load has no mileage yet." };
    }
    const c = money(rate, allMiles);
    return { ...base, kind: "exact", lowCents: c, highCents: c, counted: `${mi(allMiles)} miles (loaded + deadhead)`, note: "All miles (your pay terms)." };
  }

  // Basis not set: never pick one.
  if (loaded !== null && allMiles !== null && Math.round(allMiles * 100) !== Math.round(loaded * 100)) {
    return { ...base, kind: "range", lowCents: money(rate, loaded), highCents: money(rate, allMiles),
      counted: `${mi(loaded)} loaded to ${mi(allMiles)} total miles`,
      note: "Your miles basis isn't set, so this is a range: loaded miles only at the low end, all miles (with deadhead) at the high end." };
  }
  const single = loaded ?? allMiles;
  if (single === null) {
    return { ...base, kind: "unavailable", lowCents: null, highCents: null, counted: null,
      note: "This load has no mileage yet." };
  }
  const c = money(rate, single);
  return { ...base, kind: "assumed", lowCents: c, highCents: c, counted: `${mi(single)} miles`,
    note: "Your miles basis isn't set; this counts the load's one mileage figure. Set which miles are paid in Settings → Pay terms." };
}

/** Statuses that count toward a projection: booked or finished work, not drafts or cancelled loads. */
export const COUNTED_STATUSES: ReadonlySet<string> = new Set(["confirmed", "completed"]);

/** Monday..Sunday (YYYY-MM-DD) containing `today` (YYYY-MM-DD in the viewer's zone). */
export function weekBounds(today: string): { start: string; end: string } {
  const d = new Date(`${today}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const shift = (days: number) => {
    const x = new Date(d.getTime());
    x.setUTCDate(x.getUTCDate() + days);
    return x.toISOString().slice(0, 10);
  };
  return { start: shift(-dow), end: shift(6 - dow) };
}

export interface PeriodProjection {
  start: string;
  end: string;
  rows: Array<{ load: ProjectableLoad; projection: LoadProjection }>;
  lowCents: number;
  highCents: number;
  /** Counted loads that could not be projected. */
  unavailableCount: number;
  /** Loads in the period left out (draft/cancelled). */
  excludedCount: number;
  /** True when any counted load is a range or an assumption (the headline must say so). */
  basisAssumed: boolean;
}

export function projectPeriod(terms: PayTerms, loads: ProjectableLoad[], today: string): PeriodProjection {
  const { start, end } = weekBounds(today);
  const inWeek = loads.filter((l) => {
    const day = l.delivery_date ?? l.pickup_date;
    return day !== null && day >= start && day <= end;
  });
  const counted = inWeek.filter((l) => COUNTED_STATUSES.has(l.status));
  const rows = counted.map((load) => ({ load, projection: projectLoad(terms, load) }));
  let low = 0;
  let high = 0;
  let unavailable = 0;
  let assumed = false;
  for (const { projection } of rows) {
    if (projection.lowCents === null || projection.highCents === null) {
      unavailable += 1;
      continue;
    }
    low += projection.lowCents;
    high += projection.highCents;
    if (projection.kind === "range" || projection.kind === "assumed") assumed = true;
  }
  return { start, end, rows, lowCents: low, highCents: high, unavailableCount: unavailable, excludedCount: inWeek.length - counted.length, basisAssumed: assumed };
}

export const formatCents = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "$1,200.00" or "$1,200.00 – $1,330.00". */
export function formatRange(lowCents: number, highCents: number): string {
  return lowCents === highCents ? formatCents(lowCents) : `${formatCents(lowCents)} – ${formatCents(highCents)}`;
}
