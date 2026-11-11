// "Today" as a calendar date in the owner's zone (America/New_York) - never a
// UTC date (standing rule: no UTC in anything user-facing).
export function todayEastern(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** The instant the owner's (Eastern) day began, as an ISO string - for "today so far" counts. Never the UTC midnight. */
export function startOfTodayEasternIso(now: Date = new Date()): string {
  const day = todayEastern(now);
  // Find the UTC instant whose Eastern wall clock reads 00:00 on that day (the offset is -4 or -5 hours).
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(`${day}T0${offsetHours}:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false, day: "2-digit" }).formatToParts(candidate);
    const hour = Number(parts.find((x) => x.type === "hour")?.value) % 24;
    if (hour === 0 && todayEastern(candidate) === day) return candidate.toISOString();
  }
  return new Date(`${day}T05:00:00Z`).toISOString();
}
