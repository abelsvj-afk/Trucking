// Is a driver ready to go home, and when can it work? (design section 3). Pure. From the last home date and the agreed
// rhythm ("home every 14 days for 2") it gives days out, the due date, how urgent it is, which booked loads run past
// the due date, and which loads end at home - the windows where home time fits the schedule.

import { addDays, daysBetween, formatLong } from "@/lib/temporal";
import { normalizeState } from "./regions";

export interface HomeTimeInput {
  today: string;
  lastHomeDate?: string | null;
  everyDays?: number | null;
  minDays?: number | null;
  homeState?: string | null;
  booked: { origin: string; destination: string; destination_state?: string | null; pickup_date: string | null; delivery_date: string | null }[];
}

export type HomeLevel = "unknown" | "fine" | "soon" | "due" | "overdue";

export interface HomeTimeStatus {
  daysOut: number | null;
  dueDate: string | null;
  daysUntilDue: number | null;
  level: HomeLevel;
  /** Booked loads that deliver after the due date. */
  runPastDue: string[];
  /** Booked loads that end in his home state: the places home time can start. */
  windows: string[];
  notes: string[];
}

export function homeTimeStatus(i: HomeTimeInput): HomeTimeStatus {
  const notes: string[] = [];
  if (!i.lastHomeDate) notes.push("no last-home date recorded - tell me when he was last home");
  if (!i.everyDays) notes.push("no home-time rhythm recorded (for example: home every 14 days for 2)");
  if (!i.lastHomeDate || !i.everyDays) {
    return { daysOut: i.lastHomeDate ? daysBetween(i.lastHomeDate, i.today) : null, dueDate: null, daysUntilDue: null, level: "unknown", runPastDue: [], windows: [], notes };
  }
  const daysOut = daysBetween(i.lastHomeDate, i.today);
  const dueDate = addDays(i.lastHomeDate, i.everyDays);
  const daysUntilDue = daysBetween(i.today, dueDate);
  const level: HomeLevel = daysUntilDue < 0 ? "overdue" : daysUntilDue === 0 ? "due" : daysUntilDue <= 5 ? "soon" : "fine";

  const homeState = normalizeState(i.homeState);
  const dated = i.booked.filter((b) => b.delivery_date);
  const runPastDue = dated.filter((b) => b.delivery_date! > dueDate).map((b) => `${b.origin} → ${b.destination} (delivers ${b.delivery_date})`);
  const windows = homeState
    ? dated.filter((b) => normalizeState(b.destination_state) === homeState).map((b) => `${b.origin} → ${b.destination} (delivers ${b.delivery_date})`)
    : [];
  if (!homeState) notes.push("no home base recorded, so I can't tell which loads end at home");
  return { daysOut, dueDate, daysUntilDue, level, runPastDue, windows, notes };
}

const ICON: Record<HomeLevel, string> = { unknown: "❓", fine: "✅", soon: "🟡", due: "🟠", overdue: "🔴" };

export function formatHomeTime(name: string, s: HomeTimeStatus, minDays?: number | null): string {
  if (s.level === "unknown") return [`❓ ${name}: can't judge home time yet.`, ...s.notes.map((n) => `  - ${n}`)].join("\n");
  const when = s.daysUntilDue! < 0 ? `${-s.daysUntilDue!} day${s.daysUntilDue === -1 ? "" : "s"} overdue` : s.daysUntilDue === 0 ? "due today" : `due in ${s.daysUntilDue} day${s.daysUntilDue === 1 ? "" : "s"}`;
  const lines = [`${ICON[s.level]} ${name}: out ${s.daysOut} day${s.daysOut === 1 ? "" : "s"}, home time ${when} (${formatLong(s.dueDate!)})${minDays ? `, for ${minDays} day${minDays === 1 ? "" : "s"}` : ""}.`];
  if (s.runPastDue.length) lines.push(`  ⚠️ Booked past the due date: ${s.runPastDue.join("; ")}`);
  if (s.windows.length) lines.push(`  🏠 Loads that end at home: ${s.windows.join("; ")}`);
  else if (s.level !== "fine" && !s.notes.some((n) => n.includes("home base"))) lines.push("  🏠 No booked load ends at home yet - look for one that does.");
  for (const n of s.notes) lines.push(`  - ${n}`);
  return lines.join("\n");
}
