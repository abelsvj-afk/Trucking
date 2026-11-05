// A load's cost in HOURS, stated next to its pay (owner order 2026-11-05,
// item 2). Pure. It consumes the ONE HOS read (the clocks computed by
// lib/hud-clocks from services/api/hos-window) - there is no second HOS
// implementation here. The driving time is an ESTIMATE from miles at a stated
// average speed; the text says so. Planning only, not an ELD.

export const ASSUMED_AVG_MPH = 50;
const HOUR_MS = 3_600_000;
const DRIVE_LIMIT_MS = 11 * HOUR_MS;

/** The remaining clocks, as computed from his logged hours (all in ms, never negative). */
export interface HosGlance {
  driveLeftMs: number;
  windowLeftMs: number;
  breakDueInMs: number;
  /** null when the cycle summary was unavailable. */
  cycleLeftMs: number | null;
  cycleLabel: string | null;
  /** Rested 10 h: drive/window are full when he next goes on duty. */
  rested: boolean;
}

export interface LoadHosCost {
  /** Estimated driving hours for the load's miles, or null with no miles. */
  driveHours: number | null;
  /** Extra 10-hour resets the trip needs beyond today's remaining drive time (0 when it fits). */
  extraResets: number | null;
  fitsToday: boolean | null;
  /** One plain sentence. */
  text: string;
}

const hm = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

export function loadHosCost(miles: number | null, hos: HosGlance | null): LoadHosCost {
  if (miles === null || miles <= 0) {
    return { driveHours: null, extraResets: null, fitsToday: null, text: "No mileage on this load yet, so its hours cost can't be estimated." };
  }
  const driveMs = (miles / ASSUMED_AVG_MPH) * HOUR_MS;
  const base = `About ${hm(driveMs)} of driving (${Math.round(miles).toLocaleString("en-US")} mi at an assumed ${ASSUMED_AVG_MPH} mph)`;
  if (!hos) return { driveHours: driveMs / HOUR_MS, extraResets: null, fitsToday: null, text: `${base}. Your current clocks aren't available, so I can't say how it fits.` };

  const driveLeft = hos.rested ? DRIVE_LIMIT_MS : hos.driveLeftMs;
  const fits = driveMs <= driveLeft;
  const overflow = Math.max(0, driveMs - driveLeft);
  const extraResets = fits ? 0 : Math.ceil(overflow / DRIVE_LIMIT_MS);
  const parts = [
    fits
      ? `${base} — fits in the ${hm(driveLeft)} of drive time you have left${hos.rested ? " after your reset" : ""}.`
      : `${base} — more than the ${hm(driveLeft)} of drive time you have left; it needs ${extraResets} more 10-hour reset${extraResets === 1 ? "" : "s"}.`,
  ];
  if (hos.cycleLeftMs !== null) {
    const after = hos.cycleLeftMs - driveMs;
    parts.push(
      after >= 0
        ? `Uses about ${hm(driveMs)} of your ${hos.cycleLabel ?? "cycle"}; ${hm(after)} would be left.`
        : `Driving time alone would exceed the ${hm(hos.cycleLeftMs)} left in your ${hos.cycleLabel ?? "cycle"} — a 34-hour restart would be needed first.`,
    );
  }
  if (hos.breakDueInMs < driveMs && hos.breakDueInMs >= 0) parts.push(`A 30-minute break comes due after ${hm(hos.breakDueInMs)} of driving.`);
  parts.push("Planning only, from your logged hours — not an ELD.");
  return { driveHours: driveMs / HOUR_MS, extraResets, fitsToday: fits, text: parts.join(" ") };
}
