// Roadside inspection packet (docs/design/eld-roadside-overlay.md; owner
// spec 2026-11-09). PURE: builds the officer-facing log packet text from
// the duty rows and HUD clocks that the ONE server-side HOS read already
// produced (services/api/hos-window.ts + lib/hud-clocks.ts). No HOS math
// of its own beyond splitting segments at Eastern midnights for the
// per-day presentation - the clocks and totals it prints are the same
// figures every other surface states.
//
// PAPER-LOG HELPER, NOT AN ELD. The packet says so itself, at the top and
// the bottom: while the driver is leased on, the carrier's ELD and his
// official paper log are the legal record; this is a convenience copy.
// It contains no pay or money data, by construction (nothing money-shaped
// is even an input).

import { buildSegments, type Segment } from "./hos";
import { formatClock, type HudClocks } from "./hud-clocks";
import { todayEastern } from "./eastern-date";
import type { DutyStatus } from "@/types/entities";

export const PACKET_DAYS = 8; // today + the previous 7 days (the roadside look-back)

export const PACKET_FRAMING =
  "CONVENIENCE COPY - NOT THE CERTIFIED RECORD. This packet was assembled by the driver's own app from the hours he logged in it. While he drives under his carrier's authority, the carrier's ELD and his official paper log are the legal record of duty status.";

const STATUS_LABEL: Record<DutyStatus, string> = {
  off_duty: "Off duty",
  sleeper: "Sleeper berth",
  driving: "Driving",
  on_duty: "On duty (not driving)",
};

export interface PacketDutyRow {
  duty_status: DutyStatus;
  started_at: string;
  location?: string | null;
}

export interface RoadsidePacketInput {
  driverName: string | null;
  companyName: string | null;
  rows: PacketDutyRow[];
  clocks: HudClocks;
  /** The cycle line from services/api/hos-window.ts cycleLine() - stated as-is. */
  cycleLine: string;
  now: Date;
}

export interface RoadsidePacket {
  subject: string;
  text: string;
  fileName: string;
  /** Eastern calendar dates (YYYY-MM-DD), inclusive. */
  periodStart: string;
  periodEnd: string;
}

/** The packet period: today (Eastern) and the 7 days before it. */
export function packetPeriod(now: Date): { periodStart: string; periodEnd: string } {
  const periodEnd = todayEastern(now);
  const [y, m, d] = periodEnd.split("-").map(Number) as [number, number, number];
  const start = new Date(Date.UTC(y, m - 1, d - (PACKET_DAYS - 1)));
  const periodStart = start.toISOString().slice(0, 10);
  return { periodStart, periodEnd };
}

const etDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etTimeFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const etDayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });

function easternDateOf(ms: number): string {
  return etDateFmt.format(new Date(ms));
}

/** The instant (ms) of Eastern midnight starting the given YYYY-MM-DD Eastern date. */
export function easternMidnightMs(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  // Start from UTC noon of that calendar date (07:00/08:00 Eastern - safely
  // inside the day), read the Eastern wall time there, and step back to 00:00.
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(noonUtc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wallMs = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000;
  let mid = noonUtc - wallMs;
  // DST transition days: the offset at noon can differ from the offset at
  // midnight by an hour. Correct once and verify.
  if (easternDateOf(mid) !== dateStr) mid += mid < noonUtc ? 3_600_000 : -3_600_000;
  return mid;
}

function nextEasternDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

interface DaySlice {
  status: DutyStatus;
  startMs: number;
  endMs: number;
  location: string | null;
}

/** Segments clipped to the packet period and split at Eastern midnights, grouped by Eastern day. */
export function packetDays(rows: PacketDutyRow[], periodStart: string, periodEnd: string, nowMs: number): { date: string; slices: DaySlice[] }[] {
  const periodStartMs = easternMidnightMs(periodStart);
  const periodEndMs = easternMidnightMs(nextEasternDate(periodEnd));
  const segments: Segment[] = buildSegments(rows, nowMs).filter((s) => s.endMs > periodStartMs && s.startMs < periodEndMs);
  const locationByStart = new Map(rows.map((r) => [new Date(r.started_at).getTime(), r.location ?? null]));
  const byDay = new Map<string, DaySlice[]>();
  for (const seg of segments) {
    let cursor = Math.max(seg.startMs, periodStartMs);
    const end = Math.min(seg.endMs, periodEndMs);
    while (cursor < end) {
      const date = easternDateOf(cursor);
      const dayEnd = Math.min(easternMidnightMs(nextEasternDate(date)), end);
      const list = byDay.get(date) ?? [];
      list.push({ status: seg.status, startMs: cursor, endMs: dayEnd, location: locationByStart.get(seg.startMs) ?? null });
      byDay.set(date, list);
      cursor = dayEnd;
    }
  }
  const days: { date: string; slices: DaySlice[] }[] = [];
  for (let date = periodStart; ; date = nextEasternDate(date)) {
    days.push({ date, slices: byDay.get(date) ?? [] });
    if (date === periodEnd) break;
  }
  return days;
}

function fmtMinutes(min: number): string {
  return `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
}

function clockLines(clocks: HudClocks): string[] {
  if (clocks.state === "no-logs") return ["Current clocks: unavailable - no duty logs recorded in this app."];
  const lines = [`Current duty status: ${STATUS_LABEL[clocks.status]} (since ${etTimeFmt.format(new Date(clocks.statusSinceMs))} Eastern)`];
  for (const c of clocks.clocks) {
    lines.push(`${c.label}: ${formatClock(c.remainingMs)} left of ${formatClock(c.totalMs)}${c.tone === "expired" ? " - EXPIRED" : ""}`);
  }
  if (clocks.cycleUnavailable) lines.push("Cycle clock: unavailable from the app's records.");
  return lines;
}

export function buildRoadsidePacket(input: RoadsidePacketInput): RoadsidePacket {
  const nowMs = input.now.getTime();
  const { periodStart, periodEnd } = packetPeriod(input.now);
  const days = packetDays(input.rows, periodStart, periodEnd, nowMs);
  const driver = input.driverName?.trim() ? input.driverName.trim() : "(driver name not recorded in the app)";
  const company = input.companyName?.trim() ? input.companyName.trim() : "(company name not recorded in the app)";

  const lines: string[] = [
    "ROADSIDE INSPECTION PACKET",
    PACKET_FRAMING,
    "",
    `Driver: ${driver}`,
    `Company: ${company}`,
    `Period: ${etDayFmt.format(new Date(easternMidnightMs(periodStart) + 12 * 3_600_000))} to ${etDayFmt.format(new Date(easternMidnightMs(periodEnd) + 12 * 3_600_000))} (Eastern)`,
    `Assembled: ${etDayFmt.format(input.now)}, ${etTimeFmt.format(input.now)} Eastern`,
    "",
    "CURRENT CLOCKS",
    ...clockLines(input.clocks),
    input.cycleLine,
    "",
    "DUTY LOG BY DAY (Eastern)",
  ];

  for (const day of days) {
    const label = etDayFmt.format(new Date(easternMidnightMs(day.date) + 12 * 3_600_000));
    if (day.slices.length === 0) {
      lines.push("", `${label}: no duty entries recorded in this app.`);
      continue;
    }
    lines.push("", `${label}:`);
    let drivingMin = 0;
    let onDutyMin = 0;
    for (const s of day.slices) {
      const mins = (s.endMs - s.startMs) / 60_000;
      if (s.status === "driving") drivingMin += mins;
      if (s.status === "driving" || s.status === "on_duty") onDutyMin += mins;
      lines.push(
        `  ${etTimeFmt.format(new Date(s.startMs))} - ${etTimeFmt.format(new Date(s.endMs))}  ${STATUS_LABEL[s.status]}${s.location ? `  (${s.location})` : ""}`,
      );
    }
    lines.push(`  Day totals: driving ${fmtMinutes(drivingMin)}, on duty ${fmtMinutes(onDutyMin)}.`);
  }

  lines.push("", PACKET_FRAMING);
  const text = lines.join("\n");
  return {
    subject: `Driver log packet - ${driver} - ${periodStart} to ${periodEnd}`,
    text,
    fileName: `inspection-packet-${periodEnd}.txt`,
    periodStart,
    periodEnd,
  };
}
