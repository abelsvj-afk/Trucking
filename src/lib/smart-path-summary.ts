// Smart Path v2 (docs/design/smart-path-v2.md): the short version of a route check - four key facts and a
// one-line-per-stop timeline - so the answer is readable at a glance. Pure; every figure comes from the engine's
// result unchanged. The full text lives under "Details".

import type { RouteCheckResponse } from "@/types/smart-path";

export interface KeyFact {
  label: string;
  value: string;
  sub?: string;
}

export interface TimelineItem {
  at: string;
  icon: string;
  text: string;
}

const clock = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit" });

const hm = (min: number) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;

export function keyFacts(r: RouteCheckResponse, timeZone: string): KeyFact[] {
  const facts: KeyFact[] = [];
  facts.push({
    label: "Arrive",
    value: r.plan?.arrivalAt ? clock(r.plan.arrivalAt, timeZone) : "Can't time it",
    sub: `${Math.round(r.route.distanceMiles + (r.deadhead?.distanceMiles ?? 0))} mi · ${hm(r.verdict.assumedDriveMinutes + (r.deadhead?.providerDurationMinutes ?? 0))} driving`,
  });
  const rest = r.plan?.rests?.[0];
  facts.push(
    rest
      ? { label: "Sleep", value: clock(rest.startAt, timeZone), sub: `about mile ${Math.round(rest.distanceMilesFromOrigin)}` }
      : { label: "Sleep", value: "None needed", sub: "you make it on today's hours" },
  );
  const fuel = r.fuel.candidates[0];
  facts.push(
    fuel
      ? { label: "Fuel", value: fuel.name, sub: `${fuel.detourMiles.toFixed(1)} mi off route${fuel.savingsVsBaselineCents && fuel.savingsVsBaselineCents > 0 ? " · cheapest" : ""}` }
      : { label: "Fuel", value: "No stop found", sub: r.fuel.unavailableReason ?? "nothing near this route yet" },
  );
  const breakAt = r.plan?.breaks?.find((b) => b.kind === "break");
  facts.push(
    breakAt
      ? { label: "30-min break", value: clock(breakAt.startAt, timeZone), sub: `after ${hm(breakAt.afterDrivingMinutes)} driving` }
      : { label: "30-min break", value: "Not needed", sub: "under 8 h driving before a stop" },
  );
  return facts;
}

/** One line per thing that happens on the run, in time order. */
export function timeline(r: RouteCheckResponse, timeZone: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  if (r.deadhead) {
    items.push({ at: r.deadhead.leaveByAt, icon: "🚚", text: `Leave ${r.deadhead.startLabel} by ${clock(r.deadhead.leaveByAt, timeZone)}` });
    items.push({ at: r.deadhead.pickupArrivalAt, icon: "📦", text: `Reach the pickup (${r.load.origin})` });
  }
  for (const b of r.plan?.breaks ?? []) {
    items.push({ at: b.startAt, icon: b.kind === "workout" ? "💪" : "☕", text: b.kind === "workout" ? `Workout break, ${b.durationMinutes} min` : `${b.durationMinutes}-min break` });
  }
  for (const rest of r.plan?.rests ?? []) {
    items.push({ at: rest.startAt, icon: "🛏️", text: `Sleep until ${clock(rest.endAt, timeZone)} (about mile ${Math.round(rest.distanceMilesFromOrigin)})` });
  }
  const food = r.food.stops[0];
  if (food) items.push({ at: food.arrivalAt, icon: "🍽️", text: `${food.name} (${food.detourMiles.toFixed(1)} mi off route)` });
  if (r.plan?.arrivalAt) items.push({ at: r.plan.arrivalAt, icon: "🏁", text: `Arrive ${r.load.destination}` });
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((i) => ({ ...i, text: `${clock(i.at, timeZone)} · ${i.text}` }));
}

/**
 * Which hours the plan ran on, in his words, and the one that is holding him up (owner 2026-11-17: "why does it
 * show late if the delivery isn't until tomorrow" - the app log thought his cycle was used up and never said so).
 */
export function hoursLine(r: RouteCheckResponse): { text: string; fromAppLog: boolean; tight: boolean } | null {
  const c = r.clocks;
  if (!c) return null;
  const source = r.clocksSource ?? (c.fromLogs ? "app_log" : "fresh");
  const label = source === "eld_entered" ? "your ELD hours (as you entered them)" : source === "app_log" ? "this app's duty log" : "fresh hours (no log)";
  const parts = `${hm(c.driveLeftMin)} driving · ${hm(c.windowLeftMin)} on your 14 · ${hm(c.weekLeftMin)} on your cycle`;
  const blockers: string[] = [];
  if (c.weekLeftMin < 60) blockers.push("your cycle is (nearly) used up, so the plan has to fit a 34-hour restart before driving");
  else if (c.driveLeftMin < 60 || c.windowLeftMin < 60) blockers.push("you're (nearly) out of driving or shift time, so the plan starts with a 10-hour rest");
  const text = `Hours used: ${label} - ${parts}.${blockers.length ? ` ${blockers[0]![0]!.toUpperCase()}${blockers[0]!.slice(1)}.` : ""}`;
  return { text, fromAppLog: source === "app_log", tight: blockers.length > 0 };
}
