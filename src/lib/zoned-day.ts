// Wall-clock days in a named time zone (the carrier's), shared by the
// browser and the server. A log "day" is 00:00-24:00 on the carrier's
// clock (FMCSA: home-terminal time), never the viewer's UTC day.

function offsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The instant of a wall-clock time ("HH:MM", "24:00" allowed) on a date in a zone. */
export function zonedInstant(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map((part) => Number.parseInt(part, 10));
  const [hh, mm] = hhmm.split(":").map((part) => Number.parseInt(part, 10));
  const wall = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  // Two passes: the offset at the first guess can differ from the
  // offset at the real instant on a daylight-saving changeover day.
  const first = wall - offsetMs(wall, timeZone);
  return new Date(wall - offsetMs(first, timeZone));
}

/** The zone's UTC offset at an instant, in whole minutes (EST = -300). */
export function zoneOffsetMinutes(instantMs: number, timeZone: string): number {
  return Math.round(offsetMs(instantMs, timeZone) / 60_000);
}

/**
 * Wall-clock minutes since the day's local midnight for an instant inside
 * [dayStartMs, dayEndMs]. On a daylight-saving changeover day the elapsed
 * minutes and the clock disagree after the changeover (23 or 25 hours in
 * the day); this returns what the CLOCK showed, 0-1440, so a graph and a
 * time field both read true. During the repeated hour of a fall-back day
 * the clock repeats; the result is clamped so it never goes backwards.
 */
export function zonedWallMinutes(instantMs: number, dayStartMs: number, dayEndMs: number, timeZone: string): number {
  const elapsed = (instantMs - dayStartMs) / 60_000;
  const shift = zoneOffsetMinutes(dayEndMs - 1, timeZone) - zoneOffsetMinutes(dayStartMs, timeZone);
  if (shift === 0) return Math.max(0, Math.min(1440, elapsed));
  // find the changeover instant (the offset flips once inside the day)
  let lo = dayStartMs;
  let hi = dayEndMs - 1;
  const startOff = zoneOffsetMinutes(dayStartMs, timeZone);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (zoneOffsetMinutes(mid, timeZone) === startOff) lo = mid;
    else hi = mid;
  }
  const changeover = hi;
  const wall = instantMs < changeover ? elapsed : elapsed + shift;
  return Math.max(0, Math.min(1440, wall));
}

export function zonedDayBounds(date: string, timeZone: string): { startMs: number; endMs: number } {
  return {
    startMs: zonedInstant(date, "00:00", timeZone).getTime(),
    endMs: zonedInstant(date, "24:00", timeZone).getTime(),
  };
}

/** "YYYY-MM-DD" of an instant on the zone's calendar. */
export function zonedDate(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(instantMs),
  );
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map((part) => Number.parseInt(part, 10));
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return t.toISOString().slice(0, 10);
}
