// Calendar sequencing of his booked loads (owner 2026-11-07, temporal reasoning; design section 8.5). Pure.
// Puts the loads in pickup order, and flags what a driver needs to see: a pickup before the last delivery (overlap),
// a same-day turnaround, a long idle gap, a load that ends somewhere other than where the next one starts
// (deadhead), and loads with no dates at all. Dates are calendar days on his clock.

import { daysBetween, formatLong } from "@/lib/temporal";

export interface SequenceLoad {
  id: string;
  origin: string;
  destination: string;
  status: string;
  pickup_date: string | null;
  delivery_date: string | null;
}

export interface SequenceRow {
  load: SequenceLoad;
  /** The day it starts (pickup, else delivery). */
  start: string;
  /** The day it ends (delivery, else pickup). */
  end: string;
}

export type Warning =
  | { kind: "overlap"; before: string; after: string; days: number }
  | { kind: "same_day"; before: string; after: string }
  | { kind: "idle_gap"; before: string; after: string; days: number }
  | { kind: "deadhead"; before: string; after: string; from: string; to: string };

export interface Sequence {
  rows: SequenceRow[];
  undated: SequenceLoad[];
  warnings: Warning[];
}

export const IDLE_GAP_DAYS = 3;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const route = (l: SequenceLoad) => `${l.origin} → ${l.destination}`;

/** Does a load that ends at `a` plausibly start where `b` starts? Compares the city (text before the comma). */
function sameStop(a: string, b: string): boolean {
  const city = (s: string) => norm(s.split(",")[0] ?? s);
  return city(a) === city(b);
}

export function sequenceLoads(loads: SequenceLoad[]): Sequence {
  const undated: SequenceLoad[] = [];
  const rows: SequenceRow[] = [];
  for (const load of loads) {
    const start = load.pickup_date ?? load.delivery_date;
    const end = load.delivery_date ?? load.pickup_date;
    if (!start || !end) undated.push(load);
    else rows.push({ load, start, end: end < start ? start : end });
  }
  rows.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));

  const warnings: Warning[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]!;
    const next = rows[i]!;
    const gap = daysBetween(prev.end, next.start); // days from the last delivery to the next pickup
    if (gap < 0) warnings.push({ kind: "overlap", before: route(prev.load), after: route(next.load), days: -gap });
    else if (gap === 0) warnings.push({ kind: "same_day", before: route(prev.load), after: route(next.load) });
    else if (gap >= IDLE_GAP_DAYS) warnings.push({ kind: "idle_gap", before: route(prev.load), after: route(next.load), days: gap });
    if (!sameStop(prev.load.destination, next.load.origin)) {
      warnings.push({ kind: "deadhead", before: route(prev.load), after: route(next.load), from: prev.load.destination, to: next.load.origin });
    }
  }
  return { rows, undated, warnings };
}

export function describeWarning(w: Warning): string {
  switch (w.kind) {
    case "overlap": return `🔴 Overlap: ${w.after} starts ${w.days} day${w.days === 1 ? "" : "s"} BEFORE ${w.before} is delivered.`;
    case "same_day": return `🟠 Same-day turnaround: ${w.before} delivers the day ${w.after} picks up.`;
    case "idle_gap": return `🟡 ${w.days} idle days between ${w.before} and ${w.after}.`;
    case "deadhead": return `🛣️ Deadhead: ${w.before} ends in ${w.from}, but ${w.after} starts in ${w.to}.`;
  }
}

/** The calendar in words: one line per load with its days, then the warnings. */
export function formatSequence(seq: Sequence): string {
  if (seq.rows.length === 0 && seq.undated.length === 0) return "No booked loads in that window.";
  const lines = seq.rows.map((r) => {
    const span = r.start === r.end ? formatLong(r.start) : `${formatLong(r.start)} → ${formatLong(r.end)}`;
    return `🚚 ${route(r.load)} (${r.load.status}): ${span}`;
  });
  const out = [...lines];
  if (seq.undated.length > 0) out.push(`❓ No dates yet: ${seq.undated.map(route).join("; ")}`);
  out.push(seq.warnings.length > 0 ? seq.warnings.map(describeWarning).join("\n") : "✅ No overlaps or problem gaps between these loads.");
  return out.join("\n");
}
