import { formatMoney } from "@/lib/money-format";

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
// Pay = the MILE part (cents per mile x the miles his basis counts) + the PERCENT
// part (his percent x the load's rate), each only when set; or the figure he set
// on the load himself (pay_override_cents), which wins. (design section 8)
// This is the gross pay under his stated rate. No tax, fuel or deduction math,
// and it is a projection until the carrier's settlement says otherwise.

export interface PayTerms {
  employer_name: string;
  /** 0 = no mile part (percent-only pay needs no miles basis). */
  rate_cents_per_mile: number;
  mile_basis: "loaded" | "all" | "practical" | null;
  /** "1099" / "w2" / null = UNSET (migration 00063). Only '1099' shows a tax set-aside. */
  worker_type?: "w2" | "1099" | null;
  /** Migration 00094: tax set-aside percent in basis points; null = the 25% default. */
  tax_set_aside_bps?: number | null;
  /** Basis points of the load's rate (8500 = 85%); null/0 = no percent part. */
  percent_of_load_bps?: number | null;
  /** 0 = Sunday .. 6 = Saturday; null/undefined = UNSET (Monday-Sunday shown). */
  pay_week_ends_on?: number | null;
  /** The weekday the pay statement comes out; null/undefined = UNSET. */
  statement_weekday?: number | null;
  payday_weekday?: number | null;
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
  /** The load's gross rate in cents - the base of the percent part. */
  rate_cents?: number | null;
  /** His own figure for what this load pays him; wins over the terms. */
  pay_override_cents?: number | null;
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
  /** True when the figure is the one he set on the load himself. */
  overridden?: boolean;
}

const money = (rate: number, miles: number) => Math.round(rate * miles);
const mi = (n: number) => `${Number(n.toFixed(2)).toLocaleString("en-US")}`;
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

function projectMiles(terms: PayTerms, load: ProjectableLoad): LoadProjection {
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

function projectPercent(terms: PayTerms, load: ProjectableLoad): LoadProjection {
  const bps = terms.percent_of_load_bps ?? 0;
  const base = { loadId: load.id };
  // A $0.00 rate is "no rate yet" too: percent of nothing would silently price the load at $0.
  if (load.rate_cents == null || load.rate_cents <= 0) {
    return { ...base, kind: "unavailable", lowCents: null, highCents: null, counted: null,
      note: `Your pay includes ${pct(bps)} of the load, and this load has no rate yet — add the rate on the load.` };
  }
  const c = Math.round((load.rate_cents * bps) / 10_000);
  return { ...base, kind: "exact", lowCents: c, highCents: c,
    counted: `${pct(bps)} of the ${formatCents(load.rate_cents)} load`, note: `${pct(bps)} of the load's rate (your pay terms).` };
}

const KIND_RANK: Record<ProjectionKind, number> = { exact: 0, assumed: 1, range: 2, unavailable: 3 };

export function projectLoad(terms: PayTerms, load: ProjectableLoad): LoadProjection {
  const base = { loadId: load.id };
  if (load.pay_override_cents != null) {
    const c = load.pay_override_cents;
    return { ...base, kind: "exact", lowCents: c, highCents: c, counted: "the figure you set for this load",
      note: "You set this load's pay yourself, so the terms aren't applied. Clear it on the load to go back to your terms.", overridden: true };
  }
  const hasMiles = terms.rate_cents_per_mile > 0;
  const hasPercent = (terms.percent_of_load_bps ?? 0) > 0;
  if (!hasMiles && !hasPercent) {
    return { ...base, kind: "unavailable", lowCents: null, highCents: null, counted: null,
      note: "Your pay terms have no per-mile rate or percent yet — add one in Settings → Pay terms." };
  }
  const parts = [hasMiles ? projectMiles(terms, load) : null, hasPercent ? projectPercent(terms, load) : null].filter(
    (x): x is LoadProjection => x !== null,
  );
  if (parts.length === 1) return parts[0]!;
  const blocked = parts.find((x) => x.lowCents === null);
  if (blocked) return blocked;
  const kind = parts.reduce<ProjectionKind>((worst, x) => (KIND_RANK[x.kind] > KIND_RANK[worst] ? x.kind : worst), "exact");
  return {
    ...base,
    kind,
    lowCents: parts.reduce((t, x) => t + (x.lowCents ?? 0), 0),
    highCents: parts.reduce((t, x) => t + (x.highCents ?? 0), 0),
    counted: parts.map((x) => x.counted).join(" + "),
    note: parts.map((x) => x.note).join(" "),
  };
}

/** Statuses that count toward a projection: booked or finished work, not drafts or cancelled loads. */
export const COUNTED_STATUSES: ReadonlySet<string> = new Set(["confirmed", "completed"]);

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayOfWeek = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday

/** The 7-day pay week containing `today` (YYYY-MM-DD in the viewer's zone), ending on `endsOn` (0 = Sunday; the default = Monday..Sunday). */
export function weekBounds(today: string, endsOn: number | null | undefined = 0): { start: string; end: string } {
  const end = addDays(today, ((endsOn ?? 0) - dayOfWeek(today) + 7) % 7);
  return { start: addDays(end, -6), end };
}

/** The first `paydayWeekday` strictly after the pay week's last day; null while it is UNSET. Used for the statement day and for payday. */
export function paydayAfter(weekEnd: string, paydayWeekday: number | null | undefined): string | null {
  if (paydayWeekday == null) return null;
  return addDays(weekEnd, ((paydayWeekday - dayOfWeek(weekEnd) + 6) % 7) + 1);
}

export interface PeriodProjection {
  start: string;
  end: string;
  /** The day this pay week's statement comes out; null while not set. */
  statement: string | null;
  /** The day this pay week's money lands; null while payday is not set. */
  payday: string | null;
  /** False = the week end is UNSET and Monday-Sunday is the labeled default. */
  weekEndSet: boolean;
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

export interface PeriodOptions {
  /** Terms in force for one load (dated terms); defaults to the single `terms`. */
  termsFor?: (load: ProjectableLoad) => PayTerms;
}

function projectRange(
  terms: PayTerms,
  loads: ProjectableLoad[],
  bounds: { start: string; end: string },
  options: PeriodOptions,
): PeriodProjection {
  const { start, end } = bounds;
  const inWeek = loads.filter((l) => {
    const day = l.delivery_date ?? l.pickup_date;
    return day !== null && day >= start && day <= end;
  });
  const counted = inWeek.filter((l) => COUNTED_STATUSES.has(l.status));
  const rows = counted.map((load) => ({ load, projection: projectLoad(options.termsFor?.(load) ?? terms, load) }));
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
  return {
    start, end,
    statement: paydayAfter(end, terms.statement_weekday),
    payday: paydayAfter(end, terms.payday_weekday),
    weekEndSet: terms.pay_week_ends_on != null,
    rows, lowCents: low, highCents: high,
    unavailableCount: unavailable, excludedCount: inWeek.length - counted.length, basisAssumed: assumed,
  };
}

/** The pay week containing `today`, running total included (it grows as loads are added/delivered). */
export function projectPeriod(terms: PayTerms, loads: ProjectableLoad[], today: string, options: PeriodOptions = {}): PeriodProjection {
  return projectRange(terms, loads, weekBounds(today, terms.pay_week_ends_on), options);
}

/** The pay week BEFORE the one containing `today` - the one whose payday is usually still ahead. */
export function projectPreviousPeriod(terms: PayTerms, loads: ProjectableLoad[], today: string, options: PeriodOptions = {}): PeriodProjection {
  const current = weekBounds(today, terms.pay_week_ends_on);
  return projectRange(terms, loads, weekBounds(addDays(current.start, -1), terms.pay_week_ends_on), options);
}

export const formatCents = (cents: number) => formatMoney(cents);

/** "$1,200.00" or "$1,200.00 – $1,330.00". */
export function formatRange(lowCents: number, highCents: number): string {
  return lowCents === highCents ? formatCents(lowCents) : `${formatCents(lowCents)} – ${formatCents(highCents)}`;
}

/** "$0.55/mile", "85% of the load" or "$0.40/mile + 20% of the load" - the terms in his words. */
export function describeTerms(terms: PayTerms): string {
  const parts: string[] = [];
  if (terms.rate_cents_per_mile > 0) parts.push(`${formatMoney(terms.rate_cents_per_mile)}/mile`);
  if ((terms.percent_of_load_bps ?? 0) > 0) parts.push(`${pct(terms.percent_of_load_bps!)} of the load`);
  return parts.length > 0 ? parts.join(" + ") : "no rate set";
}

/**
 * "Fri Nov 13" for a YYYY-MM-DD day (calendar day as-is, no timezone shift).
 *
 * PAY-DATE RULE (timezone transitions 2026-11-11, lib/display-zone rule 4):
 * pay dates stay in the HOME zone (America/New_York) — pay weeks and
 * paydays are home-terminal dates, not where the truck happens to be.
 * This renders from a noon-UTC instant precisely so the calendar day
 * cannot shift under any viewer or truck zone; do not "fix" it by
 * rendering the instant in the display zone.
 */
export function formatDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
