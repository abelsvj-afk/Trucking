// Abel's daily check-in (docs/design/abel-do-what-i-ask.md section 6; owner 2026-11-16: "Morning and evening").
// One short message instead of a scatter of alerts:
//  - MORNING: when he starts his day (the first Driving / On duty entry after 3 AM on his clock), or at 9 AM if he
//    hasn't logged a start by then - hours, next load, pay this week, what's waiting on him.
//  - EVENING: when he has been off duty / sleeper for 30 minutes after working that day, between 5 PM and 9 PM -
//    driving done today, the next load, pay this week, what's waiting. After 9 PM quiet hours begin, so a late
//    evening is skipped (the morning message covers it).
// Pure planning + composition here; delivery rides the reminder scheduler's once-only claim (reminder_sends).
// Planning only, not an ELD - the hours line says so.

import { buildSegments } from "@/lib/hos";
import type { HudClocks } from "@/lib/hud-clocks";
import { formatMoney } from "@/lib/money-format";

export type CheckInKind = "morning" | "evening";

export interface DutyRow {
  duty_status: "off_duty" | "sleeper" | "driving" | "on_duty";
  started_at: string;
}

/** Hour and calendar day on his clock. */
export function localParts(nowMs: number, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number.parseInt(get("hour"), 10) };
}

const working = (s: string) => s === "driving" || s === "on_duty";

/** Which check-in is due right now (dedupe is the caller's: one per kind per local day). */
export function dueCheckIn(rows: DutyRow[], nowMs: number, timeZone: string): { kind: CheckInKind; day: string } | null {
  const { day, hour } = localParts(nowMs, timeZone);
  const today = rows.filter((r) => localParts(Date.parse(r.started_at), timeZone).day === day);
  const latest = [...rows].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)).at(-1);
  if (hour >= 5 && hour < 12) {
    const startedToday = today.some((r) => working(r.duty_status) && localParts(Date.parse(r.started_at), timeZone).hour >= 3);
    if (startedToday || hour >= 9) return { kind: "morning", day };
  }
  if (hour >= 17 && hour < 21 && latest && !working(latest.duty_status)) {
    const restedFor = nowMs - Date.parse(latest.started_at);
    const workedToday = today.some((r) => working(r.duty_status)) || (latest && Date.parse(latest.started_at) > nowMs - 14 * 3_600_000 && rows.some((r) => working(r.duty_status)));
    if (restedFor >= 30 * 60_000 && workedToday) return { kind: "evening", day };
  }
  return null;
}

/** Driving time logged today on his clock. */
export function drivingTodayMs(rows: DutyRow[], nowMs: number, timeZone: string): number {
  const { day } = localParts(nowMs, timeZone);
  return buildSegments(rows, nowMs)
    .filter((s) => s.status === "driving")
    .reduce((sum, s) => {
      // count only the part that falls on today's calendar day (walk in 15-minute steps; segments are hours long)
      let ms = 0;
      for (let t = s.startMs; t < s.endMs; t += 15 * 60_000) {
        if (localParts(t, timeZone).day === day) ms += Math.min(15 * 60_000, s.endMs - t);
      }
      return sum + ms;
    }, 0);
}

const hm = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

export interface NextLoad {
  tripNumber: string | null;
  origin: string;
  destination: string;
  pickupDate: string | null;
  deliveryDate: string | null;
}

const STATUS_WORD: Record<string, string> = { off_duty: "Off", sleeper: "Sleeper", driving: "Driving", on_duty: "On duty" };

/**
 * Yesterday's log on his clock as one short line (owner 2026-11-17: "morning log check") - so a wrong or missing
 * entry is caught the next morning instead of turning into a wrong plan. Null when nothing was logged yesterday.
 */
export function yesterdayLogLine(rows: DutyRow[], nowMs: number, timeZone: string): string | null {
  const today = localParts(nowMs, timeZone).day;
  const noon = Date.parse(`${today}T12:00:00Z`) - 24 * 3_600_000;
  const yesterday = new Date(noon).toISOString().slice(0, 10);
  const time = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const parts = buildSegments(rows, nowMs)
    .filter((seg) => {
      const a = localParts(seg.startMs, timeZone).day;
      const b = localParts(Math.max(seg.startMs, seg.endMs - 1), timeZone).day;
      return a <= yesterday && b >= yesterday;
    })
    .map((seg) => `${STATUS_WORD[seg.status] ?? seg.status} ${time(seg.startMs)}–${time(seg.endMs)}`);
  if (parts.length === 0) return null;
  return `📒 Yesterday's log: ${parts.join(" · ")}. Right? If not, tell me what to fix (like "I was off from 9 PM").`;
}

export interface DeliveredLoad {
  id: string;
  label: string;
  deliveryDate: string;
}

/**
 * Loads delivered today or yesterday with no BOL filed on them (owner 2026-11-17: missing paperwork). A document on
 * the load typed as a BOL, or a photo he sent as paperwork, counts - lenient on purpose, so it never nags about a
 * load he already covered. Null when nothing is missing.
 */
export function missingBolLine(delivered: DeliveredLoad[], loadIdsWithPaperwork: Set<string>): string | null {
  const missing = delivered.filter((l) => !loadIdsWithPaperwork.has(l.id));
  if (missing.length === 0) return null;
  const names = missing.map((l) => l.label).join(", ");
  return `📄 No BOL filed yet for ${names} - send me a photo of the signed BOL and I'll file it on the load.`;
}

export interface CheckInFacts {
  kind: CheckInKind;
  /** Morning only: yesterday's log line (yesterdayLogLine). */
  logLine?: string | null;
  /** Smart Path's current answer for the active load (owner 2026-11-17: "Abel should use it"). */
  smartPathLine?: string | null;
  /** Evening only: loads delivered without a BOL filed (missingBolLine). */
  paperworkLine?: string | null;
  /** Morning only: the way home once the monthly goal is covered (services/bot/way-home.ts). */
  homeLine?: string | null;
  clocks: HudClocks | null;
  drivingTodayMs: number;
  nextLoad: NextLoad | null;
  payWeek: { lowCents: number; highCents: number } | null;
  waitingCount: number;
}

const dayWords = (d: string | null) => {
  if (!d) return null;
  const date = new Date(`${d}T12:00:00Z`);
  return date.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
};

function hoursLine(clocks: HudClocks | null): string | null {
  if (!clocks || clocks.state !== "ready") return null;
  const by = (k: string) => clocks.clocks.find((c) => c.key === k);
  const parts = [
    by("drive") && `${hm(by("drive")!.remainingMs)} driving`,
    by("window") && `${hm(by("window")!.remainingMs)} in your 14`,
    by("cycle") && `${hm(by("cycle")!.remainingMs)} on your cycle`,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `⏱️ Hours left: ${parts.join(" · ")}${clocks.rested ? " (fresh after your rest)" : ""}. Planning only, not an ELD.`;
}

/** The message. Every line is a fact from his records; a missing fact is left out, never guessed. */
export function composeCheckIn(f: CheckInFacts): string {
  const lines = [f.kind === "morning" ? "☀️ Good morning — here's your day:" : "🌙 Day's wrap-up:"];
  if (f.kind === "morning") {
    const h = hoursLine(f.clocks);
    if (h) lines.push(h);
  } else if (f.drivingTodayMs > 0) {
    lines.push(`🚚 Driving today: ${hm(f.drivingTodayMs)}.`);
  }
  if (f.nextLoad) {
    const when = [f.nextLoad.pickupDate && `pickup ${dayWords(f.nextLoad.pickupDate)}`, f.nextLoad.deliveryDate && `delivery ${dayWords(f.nextLoad.deliveryDate)}`]
      .filter(Boolean)
      .join(", ");
    lines.push(`📍 ${f.kind === "morning" ? "Load" : "Next up"}: ${f.nextLoad.tripNumber ? `Trip ${f.nextLoad.tripNumber}, ` : ""}${f.nextLoad.origin} → ${f.nextLoad.destination}${when ? ` (${when})` : ""}.`);
  } else {
    lines.push("📍 No upcoming load on file.");
  }
  if (f.smartPathLine) lines.push(f.smartPathLine);
  if (f.payWeek && f.payWeek.highCents > 0) {
    const money = f.payWeek.lowCents === f.payWeek.highCents ? formatMoney(f.payWeek.lowCents) : `${formatMoney(f.payWeek.lowCents)} to ${formatMoney(f.payWeek.highCents)}`;
    lines.push(`💵 This pay week so far: ${money}.`);
  }
  if (f.kind === "morning" && f.logLine) lines.push(f.logLine);
  if (f.kind === "evening" && f.paperworkLine) lines.push(f.paperworkLine);
  if (f.kind === "morning" && f.homeLine) lines.push(f.homeLine);
  if (f.waitingCount > 0) {
    lines.push(`⏳ ${f.waitingCount} thing${f.waitingCount === 1 ? " is" : "s are"} waiting on you — say "what's waiting".`);
  }
  return lines.join("\n");
}
