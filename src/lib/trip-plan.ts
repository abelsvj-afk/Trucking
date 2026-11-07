// "Can I make it?" (owner 2026-11-07; design section 6). Pure. Given the miles, an average speed and the driver's CURRENT
// hours-of-service clocks, it simulates the drive under the federal property-carrying limits - 11 hours driving, the
// 14-hour window, a 30-minute break after 8 hours of driving, 10 consecutive hours off to reset - and says when he
// arrives, where a break or a reset lands, and whether a given appointment is reachable. It is planning arithmetic,
// not a promise: traffic, weather, fuel and loading time are NOT modelled and the answer says so. The limits are the
// rule set the app's own HOS clocks use (lib/hud-clocks.ts); the 70-hour cycle is checked when its remainder is known.

export const HOUR_MS = 3_600_000;
export const BREAK_MS = 30 * 60_000;
export const RESET_MS = 10 * HOUR_MS;
export const DRIVE_LIMIT_MS = 11 * HOUR_MS;
export const WINDOW_LIMIT_MS = 14 * HOUR_MS;
export const BREAK_AFTER_MS = 8 * HOUR_MS;
export const DEFAULT_MPH = 50;

export interface Clocks {
  driveLeftMs: number;
  windowLeftMs: number;
  /** Driving time until a 30-minute break is required. */
  breakDueInMs: number;
  /** Remaining 60/70-hour cycle time, or null when unknown. */
  cycleLeftMs?: number | null;
}

export interface Stop {
  kind: "break" | "reset";
  /** Epoch ms the stop starts. */
  at: number;
  /** Miles driven when it happens. */
  atMile: number;
}

export interface TripPlan {
  /** Epoch ms of arrival. */
  arriveAt: number;
  driveMs: number;
  stops: Stop[];
  resets: number;
  /** True when the 70-hour cycle runs out before the trip ends. */
  cycleShort: boolean;
}

const fresh = (): Clocks => ({ driveLeftMs: DRIVE_LIMIT_MS, windowLeftMs: WINDOW_LIMIT_MS, breakDueInMs: BREAK_AFTER_MS });

export function planTrip(miles: number, mph: number, now: number, clocks: Clocks | null): TripPlan {
  const speed = mph > 0 ? mph : DEFAULT_MPH;
  const totalDriveMs = Math.ceil((Math.max(0, miles) / speed) * HOUR_MS);
  let c: Clocks = clocks ? { ...clocks } : fresh();
  let t = now;
  let remaining = totalDriveMs;
  let driven = 0;
  const stops: Stop[] = [];
  const mileAt = () => Math.round((driven / HOUR_MS) * speed);

  while (remaining > 0) {
    // out of drive time or window: a 10-hour reset restores everything
    if (c.driveLeftMs <= 0 || c.windowLeftMs <= 0) {
      stops.push({ kind: "reset", at: t, atMile: mileAt() });
      t += RESET_MS;
      c = { ...fresh(), cycleLeftMs: c.cycleLeftMs };
      continue;
    }
    // break due: 30 minutes, which burns window but not drive time, and restarts the 8-hour count
    if (c.breakDueInMs <= 0) {
      stops.push({ kind: "break", at: t, atMile: mileAt() });
      t += BREAK_MS;
      c.windowLeftMs -= BREAK_MS;
      c.breakDueInMs = BREAK_AFTER_MS;
      continue;
    }
    const chunk = Math.min(remaining, c.driveLeftMs, c.windowLeftMs, c.breakDueInMs);
    t += chunk;
    driven += chunk;
    remaining -= chunk;
    c.driveLeftMs -= chunk;
    c.windowLeftMs -= chunk;
    c.breakDueInMs -= chunk;
    if (c.cycleLeftMs != null) c.cycleLeftMs -= chunk;
  }
  const cycleShort = clocks?.cycleLeftMs != null && clocks.cycleLeftMs < totalDriveMs;
  return { arriveAt: t, driveMs: totalDriveMs, stops, resets: stops.filter((s) => s.kind === "reset").length, cycleShort };
}

const fmtDuration = (ms: number) => {
  const mins = Math.round(Math.abs(ms) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
};

/** An epoch in Eastern time, in words: "Sat Nov 7, 4:15 PM ET". */
export function easternStamp(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return `${day}, ${time} ET`;
}

/** The epoch of a wall-clock time on a calendar day in America/New_York (handles daylight saving). */
export function easternToEpoch(day: string, hour: number, minute: number): number | null {
  const target = `${day} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  for (const offsetHours of [4, 5]) {
    const guess = Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) + offsetHours * HOUR_MS;
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    if (`${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}` === target) return guess;
  }
  return null;
}

/** "8am", "8:30 pm", "14:00", "0800" -> {hour, minute}; null when unreadable. */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, "");
  let m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(t);
  if (m) {
    let h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    if (m[3] === "pm" && h !== 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return { hour: h, minute: Number(m[2] ?? 0) };
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(t) ?? /^(\d{2})(\d{2})$/.exec(t);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h <= 23 && min <= 59 ? { hour: h, minute: min } : null;
  }
  return null;
}

export function describeTripPlan(plan: TripPlan, now: number, miles: number, mph: number, appointment: number | null, usedClocks: boolean): string {
  const lines = [
    `🚚 ${Math.round(miles)} miles at an average ${mph} mph = ${fmtDuration(plan.driveMs)} of driving.`,
    `🕒 Leaving now (${easternStamp(now)}), you arrive ${easternStamp(plan.arriveAt)} (${fmtDuration(plan.arriveAt - now)} door to door).`,
  ];
  const breaks = plan.stops.filter((s) => s.kind === "break");
  if (breaks.length) lines.push(`☕ ${breaks.length} required 30-minute break${breaks.length === 1 ? "" : "s"} (after 8 hours of driving).`);
  if (plan.resets) lines.push(`🛌 ${plan.resets} required 10-hour reset${plan.resets === 1 ? "" : "s"} - your 11-hour or 14-hour limit runs out first (about mile ${plan.stops.find((s) => s.kind === "reset")!.atMile}).`);
  if (plan.cycleShort) lines.push("🔴 Your 70-hour cycle runs out before this trip ends - you would need a 34-hour restart first.");
  if (appointment !== null) {
    const margin = appointment - plan.arriveAt;
    lines.push(
      margin >= 0
        ? `✅ Appointment ${easternStamp(appointment)}: you make it with ${fmtDuration(margin)} to spare.`
        : `❌ Appointment ${easternStamp(appointment)}: you would arrive ${fmtDuration(margin)} LATE. Call the receiver early, or find a way to start sooner.`,
    );
  }
  lines.push(usedClocks ? "Uses your current hours-of-service clocks." : "No hours-of-service history was available, so this assumes you start with full hours (11 driving / 14 window).");
  lines.push("Planning arithmetic only: traffic, weather, fuel stops, loading and unloading time are not included - add a buffer.");
  return lines.join("\n");
}
