// "Today" as a calendar date in the owner's zone (America/New_York) - never a
// UTC date (standing rule: no UTC in anything user-facing).
export function todayEastern(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
