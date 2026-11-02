// GAP-08 (Fresh-Eyes Register 2026-11-02) — the day-wrap.
//
// Nobody reconciles today against today's load: the fuel that
// didn't get logged, the POD that didn't get photographed, the
// duty change still sitting at "driving". This module compares
// what the day should contain with what the records contain and
// asks only about the gaps. Pure computation over the day's rows —
// the API route, the Home card, and Abel's get_day_wrap tool all
// quote this one pass.

import type { DetentionSummary } from "./detention";
import type { PaperworkState } from "./paperwork";
import type { DutyLog } from "@/types/entities";

export interface DayWrapItem {
  kind: "duty" | "fuel" | "paperwork" | "detention" | "proposals";
  severity: "gap" | "info" | "ok";
  text: string;
}

export interface DayWrapInput {
  /** YYYY-MM-DD in America/New_York — the driver's day, not UTC's. */
  date: string;
  dutyLogs: DutyLog[];
  /** Miles driven today, from odometer spread across today's logs (null when unknown). */
  odometerMilesToday: number | null;
  fuelLoggedToday: boolean;
  hasActiveLoad: boolean;
  /** Paperwork states for loads delivered/completed today, with lane labels. */
  paperwork: { loadLabel: string; state: PaperworkState }[];
  /** Detention summaries for loads whose clock closed today, with lane labels. */
  detention: { loadLabel: string; summary: DetentionSummary }[];
  pendingProposals: number;
  now: Date;
}

export function buildDayWrap(input: DayWrapInput): DayWrapItem[] {
  const items: DayWrapItem[] = [];
  const logs = [...input.dutyLogs].sort(
    (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
  );

  // --- duty ------------------------------------------------------------
  if (logs.length === 0) {
    if (input.hasActiveLoad) {
      items.push({
        kind: "duty",
        severity: "gap",
        text: "No duty entries logged today, but a load is active — the day's hours aren't in the helper yet.",
      });
    }
  } else {
    const last = logs[logs.length - 1]!;
    if (last.duty_status === "driving") {
      const hours = (input.now.getTime() - Date.parse(last.started_at)) / 3_600_000;
      if (hours >= 2) {
        items.push({
          kind: "duty",
          severity: "gap",
          text: `Your last duty change was 'driving' at ${new Date(last.started_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} — still driving, or did the day end without the change getting logged?`,
        });
      }
    }
  }

  // --- fuel vs miles -----------------------------------------------------
  if (input.odometerMilesToday != null && input.odometerMilesToday >= 150 && !input.fuelLoggedToday) {
    items.push({
      kind: "fuel",
      severity: "gap",
      text: `${input.odometerMilesToday} miles on the odometer today and no fuel logged — if you fueled, the receipt belongs in the books (it feeds MPG and IFTA).`,
    });
  }

  // --- paperwork -----------------------------------------------------------
  for (const entry of input.paperwork) {
    if (!entry.state.complete) {
      items.push({
        kind: "paperwork",
        severity: "gap",
        text: `${entry.loadLabel}: ${entry.state.summaryLine}`,
      });
    }
  }

  // --- detention money -----------------------------------------------------
  for (const entry of input.detention) {
    if (entry.summary.totalOwedCents != null && entry.summary.totalOwedCents > 0) {
      items.push({
        kind: "detention",
        severity: "info",
        text: `${entry.loadLabel}: detention owed $${(entry.summary.totalOwedCents / 100).toFixed(2)} — the claim pack is ready on the load page.`,
      });
    } else if (entry.summary.totalBillableHours > 0) {
      items.push({
        kind: "detention",
        severity: "info",
        text: `${entry.loadLabel}: ${entry.summary.totalBillableHours} billable detention hour(s) today — add the rate from the rate con to price the claim.`,
      });
    }
  }

  // --- proposals waiting ---------------------------------------------------
  if (input.pendingProposals > 0) {
    items.push({
      kind: "proposals",
      severity: "info",
      text: `${input.pendingProposals} proposed record${input.pendingProposals === 1 ? " is" : "s are"} waiting for your yes in the Assistant.`,
    });
  }

  if (items.length === 0) {
    items.push({
      kind: "duty",
      severity: "ok",
      text: "The day checks out — duty, fuel, and paperwork all line up with the records.",
    });
  }
  return items;
}

/** ET calendar date (YYYY-MM-DD) for an instant — the driver's day boundary. */
export function easternDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
