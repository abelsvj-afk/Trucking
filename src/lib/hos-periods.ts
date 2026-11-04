// Carrier-anchored HOS period math (Reliability Unit B - design docs/
// reliability-wave1-design-package.md B.2.4/B.2.5, F-015).
//
// FMCSA's 60/7 and 70/8 limits run over rolling periods of 7 or 8
// consecutive 24-hour periods that begin at the time of day specified
// by the motor carrier (the anchor). This module divides time into
// those periods. Two properties are the whole point:
//
// - The anchor is a wall-clock time IN THE CARRIER'S TIMEZONE
//   (hos_carrier_timezone), never the viewer's: period boundaries are
//   computed in that zone regardless of where the driver or the phone
//   currently is (package timezone rule 1; Rev 3 / R2-05). Crossing a
//   timezone line never moves a boundary.
// - A period is the span from one anchor wall time to the next day's:
//   boundaries are derived per local date, so a period spanning a DST
//   transition is 23 or 25 elapsed hours - the same way a paper log
//   day starting at the carrier's start time behaves - rather than a
//   fixed 24h chain drifting off the anchor.
//
// Pure functions over Intl - no I/O, identical on server and client.

import { isValidTimeZone } from "./time";

export type HosCycle = "70/8" | "60/7";

export interface HosCarrierConfig {
  cycle: HosCycle;
  /** Local time-of-day "HH:MM" at which each carrier period begins. */
  periodAnchor: string;
  restartEnabled: boolean;
  /** IANA timezone the anchor is interpreted in. */
  carrierTimeZone: string;
}

/**
 * The owner-approved PROVISIONAL carrier configuration (design B.2.5 /
 * decision register): defaults that stand until the carrier's actual
 * anchor, cycle, restart policy, and timezone are learned. They are
 * configuration, never verified carrier facts, and the UI labels them
 * as provisional wherever they are shown.
 */
export const PROVISIONAL_HOS_CONFIG: HosCarrierConfig = {
  cycle: "70/8",
  periodAnchor: "00:00",
  restartEnabled: true,
  carrierTimeZone: "America/New_York",
};

/** "HH:MM" 24-hour wall time - mirrors migration 00042's CHECK. */
/**
 * True while a carrier configuration is still the labeled PROVISIONAL
 * defaults (all four fields equal them) - the one test every surface
 * uses before it words the settings as the carrier's real rules.
 */
export function isProvisionalCarrierConfig(config: HosCarrierConfig): boolean {
  return (
    config.cycle === PROVISIONAL_HOS_CONFIG.cycle &&
    config.periodAnchor === PROVISIONAL_HOS_CONFIG.periodAnchor &&
    config.restartEnabled === PROVISIONAL_HOS_CONFIG.restartEnabled &&
    config.carrierTimeZone === PROVISIONAL_HOS_CONFIG.carrierTimeZone
  );
}

export const PERIOD_ANCHOR_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidPeriodAnchor(anchor: string): boolean {
  return PERIOD_ANCHOR_PATTERN.test(anchor);
}

/**
 * Coerce a raw config (e.g. a companies row, possibly pre-migration
 * with missing columns) into a valid HosCarrierConfig, substituting
 * the provisional default for any absent/invalid field.
 */
export function normalizeHosCarrierConfig(raw: {
  cycle?: unknown;
  periodAnchor?: unknown;
  restartEnabled?: unknown;
  carrierTimeZone?: unknown;
}): HosCarrierConfig {
  return {
    cycle: raw.cycle === "60/7" ? "60/7" : "70/8",
    periodAnchor:
      typeof raw.periodAnchor === "string" && isValidPeriodAnchor(raw.periodAnchor)
        ? raw.periodAnchor
        : PROVISIONAL_HOS_CONFIG.periodAnchor,
    restartEnabled:
      typeof raw.restartEnabled === "boolean"
        ? raw.restartEnabled
        : PROVISIONAL_HOS_CONFIG.restartEnabled,
    carrierTimeZone:
      typeof raw.carrierTimeZone === "string" && isValidTimeZone(raw.carrierTimeZone)
        ? raw.carrierTimeZone
        : PROVISIONAL_HOS_CONFIG.carrierTimeZone,
  };
}

/** Periods counted by a cycle: 70/8 counts 8 periods, 60/7 counts 7. */
export function cyclePeriodCount(cycle: HosCycle): number {
  return cycle === "70/8" ? 8 : 7;
}

/** The cycle's on-duty limit in minutes: 70h or 60h. */
export function cycleLimitMinutes(cycle: HosCycle): number {
  return cycle === "70/8" ? 70 * 60 : 60 * 60;
}

const DAY_MS = 86_400_000;

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

function zonedParts(instantMs: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // h23 can still report 24 at midnight in some ICU builds
    minute: get("minute"),
    second: get("second"),
  };
}

/** The zone's UTC offset at an instant: wall-clock-as-UTC minus instant. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const p = zonedParts(instantMs, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time in a zone. Two-pass offset
 * resolution: guess from the offset at the naive guess, then correct
 * with the offset at the corrected instant (they differ only around
 * DST transitions).
 */
function zonedWallToUtcMs(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const firstOffset = zoneOffsetMs(wallAsUtc, timeZone);
  let utc = wallAsUtc - firstOffset;
  const secondOffset = zoneOffsetMs(utc, timeZone);
  if (secondOffset !== firstOffset) {
    utc = wallAsUtc - secondOffset;
  }
  return utc;
}

function anchorParts(anchor: string): { hour: number; minute: number } {
  const [hour, minute] = anchor.split(":").map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

function shiftLocalDate(
  parts: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * The start instant of the carrier period containing `instantMs`: the
 * most recent anchor wall time in the carrier zone at or before it.
 */
export function hosPeriodStartMs(instantMs: number, config: HosCarrierConfig): number {
  const { hour, minute } = anchorParts(config.periodAnchor);
  const local = zonedParts(instantMs, config.carrierTimeZone);
  let start = zonedWallToUtcMs({ ...local, hour, minute }, config.carrierTimeZone);
  if (start > instantMs) {
    const previousDate = shiftLocalDate(local, -1);
    start = zonedWallToUtcMs({ ...previousDate, hour, minute }, config.carrierTimeZone);
  }
  return start;
}

/**
 * Move a period boundary by whole periods: the anchor wall time on the
 * local date `periods` days after the boundary's own local date.
 * (Date arithmetic, not periodStart +/- n*24h, so boundaries stay on
 * the anchor wall time across DST transitions.)
 */
export function shiftHosPeriodStartMs(
  periodStartMs: number,
  periods: number,
  config: HosCarrierConfig,
): number {
  const { hour, minute } = anchorParts(config.periodAnchor);
  const local = zonedParts(periodStartMs, config.carrierTimeZone);
  const targetDate = shiftLocalDate(local, periods);
  return zonedWallToUtcMs({ ...targetDate, hour, minute }, config.carrierTimeZone);
}

/**
 * The B.2.4 calculation window: it opens at the start of the
 * carrier-anchored period that begins (cycle periods + 2) periods
 * before the current period - 10 periods back for 70/8, 9 for 60/7.
 * The two extra periods let the cycle engine evaluate a 34-hour
 * restart whose qualifying interval began before the counted periods,
 * and guarantee no counted period is ever truncated.
 */
export function hosCalculationWindowStartMs(nowMs: number, config: HosCarrierConfig): number {
  const currentPeriodStart = hosPeriodStartMs(nowMs, config);
  return shiftHosPeriodStartMs(
    currentPeriodStart,
    -(cyclePeriodCount(config.cycle) + 2),
    config,
  );
}
