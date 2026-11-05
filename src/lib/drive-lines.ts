// Drive Mode - the closed spoken set (G-6). Split out of drive.ts
// (file decomposition, 2026-11-06); behavior unchanged, and drive.ts
// re-exports everything here so existing imports keep working.

import { DRIVE_COPY } from "./drive";
import type { DriveEvent, DrivePlanSnapshot, DriveSession, DriveStop } from "./drive";

// ---------------------------------------------------------------------------
// The closed spoken set (G-6) - text builders. Every line Drive can
// say is built here; the page speaks events, never ad-lib copy.

function milesPhrase(miles: number): string {
  if (miles < 0.15) return "just ahead";
  if (miles < 1.05) return "in about a mile";
  return `in ${Math.round(miles)} miles`;
}

export function goSummarySpeech(plan: DrivePlanSnapshot): string {
  const parts: string[] = [];
  switch (plan.verdictStatus) {
    case "on_time":
    case "early":
      parts.push("Legal all the way.");
      break;
    case "late":
      parts.push("Legal, but late as planned. The tradeoff is on the parked screen.");
      break;
    case "not_legal":
      parts.push(
        "Heads up: this plan is not legal as planned. Drive will guide the stops, but fix the plan when you park.",
      );
      break;
  }
  if (plan.clocks) {
    const hours = Math.floor(plan.clocks.driveLeftMin / 60);
    const minutes = plan.clocks.driveLeftMin % 60;
    parts.push(
      minutes > 0
        ? `About ${hours} hours ${minutes} minutes of drive time left.`
        : `About ${hours} hours of drive time left.`,
    );
  }
  const workout = plan.stops.find((stop) => stop.kind === "workout");
  if (workout) parts.push("Workout fits at your break.");
  const sleep = plan.stops.find((stop) => stop.kind === "rest");
  if (sleep) {
    parts.push(`Sleep stop near mile ${Math.round(sleep.fraction * plan.totalMiles)}.`);
  }
  const first = plan.stops.find(
    (stop) => stop.kind !== "start" && stop.kind !== "pickup",
  );
  if (first) {
    parts.push(`First stop: ${first.name} ${milesPhrase(first.fraction * plan.totalMiles)}.`);
  } else {
    const pickup = plan.stops.find((stop) => stop.kind === "pickup");
    if (pickup && plan.stops.some((stop) => stop.kind === "start")) {
      parts.push(`First stop: the pickup ${milesPhrase(pickup.fraction * plan.totalMiles)}.`);
    }
  }
  return parts.join(" ");
}

export function approachSpeech(stop: DriveStop): string {
  if (stop.kind === "workout") {
    const gym = stop.placeKind === "gym" ? ", gym next door" : "";
    return `Your workout stop is in 2 miles — ${stop.durationMinutes ?? 60} minutes${gym}.`;
  }
  if (stop.kind === "fuel") return `Fuel in 2 miles: ${stop.name}.`;
  if (stop.kind === "rest") return `Your sleep stop is in 2 miles.`;
  if (stop.kind === "delivery") return `Delivery in 2 miles: ${stop.name}.`;
  if (stop.kind === "pickup") return `Pickup in 2 miles: ${stop.name}.`;
  return `${stop.name} in 2 miles.`;
}

export function arrivalSpeech(stop: DriveStop): string {
  if (stop.kind === "workout") {
    return `You're at your workout stop — ${stop.durationMinutes ?? 60} minutes.`;
  }
  if (stop.kind === "rest") return "You're at your sleep stop.";
  return `You're at ${stop.name}.`;
}

export function skipSpeech(skipped: DriveStop, next: DriveStop | null): string {
  return next ? `Skipped. Next is ${next.name}.` : "Skipped. That was the last stop.";
}

export function missedSpeech(stop: DriveStop): string {
  return `You passed ${stop.name} — it's off the plan now.`;
}

export function recoveredSpeech(next: DriveStop | null): string {
  return next ? `Back on you. Next stop ${next.name}.` : "Back on you.";
}

export function cliffSpeech(clock: "break" | "window", minutesLeft: 60 | 30): string {
  const span = minutesLeft === 60 ? "One hour" : "Thirty minutes";
  // G-6 #3: cliff warnings are projections and say so out loud -
  // he must never mistake one for the ELD's word.
  return clock === "break"
    ? `${span} to your break, by projection.`
    : `${span} left on your 14, by projection.`;
}

/** Speech text for one event; null for events that don't speak. */
export function speechForEvent(
  event: DriveEvent,
  plan: DrivePlanSnapshot,
  session: DriveSession,
): string | null {
  switch (event.type) {
    case "approach":
      return approachSpeech(plan.stops[event.stopIndex]!);
    case "arrived":
      return arrivalSpeech(plan.stops[event.stopIndex]!);
    case "missed":
      return missedSpeech(plan.stops[event.stopIndex]!);
    case "gps-lost-spoken":
      return DRIVE_COPY.gpsLostSpoken;
    case "gps-recovered": {
      const next =
        event.stopIndex < plan.stops.length &&
        session.stopStatus[event.stopIndex] === "pending"
          ? plan.stops[event.stopIndex]!
          : null;
      return recoveredSpeech(next);
    }
    case "cliff":
      return cliffSpeech(event.clock, event.minutesLeft);
    default:
      return null;
  }
}

