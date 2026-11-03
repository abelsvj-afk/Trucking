// GAP-04 (Fresh-Eyes Register 2026-11-02) — the facility clock.
//
// The app's own job knowledge teaches "times written down are how
// detention gets paid"; this module is where those times finally
// live and turn into money. Pure functions over detention_stamps
// rows (migration 00046) plus the load's detention terms:
//
// - The clock starts at the ARRIVAL stamp (per stop: pickup and
//   delivery clocks are computed separately).
// - Free time (load.detention_free_minutes, from the rate con) runs
//   from arrival. When the load carries no terms, the industry-
//   standard default of 120 free minutes is assumed and LABELED as
//   an assumption everywhere the number is shown — never silent.
// - Billable time is everything past free time until DEPARTURE,
//   billed per started hour at load.detention_rate_cents_per_hour.
//   With no rate on the load the time is still computed and the
//   money is reported as unknown, not invented.
// - The claim pack is assembled here so the load page, Abel, and a
//   future invoice all quote the same numbers.

import type { DetentionStamp, DetentionStopKind, Load } from "@/types/entities";

export const DEFAULT_FREE_MINUTES = 120;

export interface StopClock {
  stopKind: DetentionStopKind;
  arrivalAt: string | null;
  doorAt: string | null;
  loadingDoneAt: string | null;
  departureAt: string | null;
  /** Minutes arrival -> departure; null while the clock is open or unstarted. */
  totalMinutes: number | null;
  /** Minutes spent waiting for a door (arrival -> door). */
  waitForDoorMinutes: number | null;
  /** Minutes at the door being worked (door -> loading_done). */
  atDoorMinutes: number | null;
  /** Minutes past free time, billable. Null until departure stamps. */
  billableMinutes: number | null;
  billableHours: number | null;
  owedCents: number | null;
  clockOpen: boolean;
}

export interface DetentionSummary {
  stops: StopClock[];
  totalBillableMinutes: number;
  totalBillableHours: number;
  /** Null when any closed clock lacks a rate on the load. */
  totalOwedCents: number | null;
  anyClockOpen: boolean;
  freeMinutes: number;
  freeMinutesAssumed: boolean;
  rateCentsPerHour: number | null;
}

function minutesBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));
}

function firstOf(stamps: DetentionStamp[], type: string): string | null {
  const hit = stamps.find((s) => s.stamp_type === type);
  return hit ? hit.occurred_at : null;
}

export function computeStopClock(
  stamps: DetentionStamp[],
  stopKind: DetentionStopKind,
  terms: { freeMinutes: number; rateCentsPerHour: number | null },
): StopClock {
  const mine = stamps
    .filter((s) => s.stop_kind === stopKind)
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const arrivalAt = firstOf(mine, "arrival");
  const doorAt = firstOf(mine, "door");
  const loadingDoneAt = firstOf(mine, "loading_done");
  const departureAt = firstOf(mine, "departure");

  const totalMinutes = arrivalAt && departureAt ? minutesBetween(arrivalAt, departureAt) : null;
  const billableMinutes =
    totalMinutes != null ? Math.max(0, totalMinutes - terms.freeMinutes) : null;
  const billableHours = billableMinutes != null ? Math.ceil(billableMinutes / 60) : null;

  return {
    stopKind,
    arrivalAt,
    doorAt,
    loadingDoneAt,
    departureAt,
    totalMinutes,
    waitForDoorMinutes: arrivalAt && doorAt ? minutesBetween(arrivalAt, doorAt) : null,
    atDoorMinutes: doorAt && loadingDoneAt ? minutesBetween(doorAt, loadingDoneAt) : null,
    billableMinutes,
    billableHours,
    owedCents:
      billableHours != null && terms.rateCentsPerHour != null
        ? billableHours * terms.rateCentsPerHour
        : null,
    clockOpen: arrivalAt != null && departureAt == null,
  };
}

export function computeDetention(load: Load, stamps: DetentionStamp[]): DetentionSummary {
  const freeMinutesAssumed = load.detention_free_minutes == null;
  const freeMinutes = load.detention_free_minutes ?? DEFAULT_FREE_MINUTES;
  const terms = { freeMinutes, rateCentsPerHour: load.detention_rate_cents_per_hour };
  const stops = (["pickup", "delivery"] as const)
    .map((kind) => computeStopClock(stamps, kind, terms))
    .filter((clock) => clock.arrivalAt != null);

  const closed = stops.filter((s) => s.billableMinutes != null);
  return {
    stops,
    totalBillableMinutes: closed.reduce((sum, s) => sum + (s.billableMinutes ?? 0), 0),
    totalBillableHours: closed.reduce((sum, s) => sum + (s.billableHours ?? 0), 0),
    totalOwedCents: closed.every((s) => s.owedCents != null)
      ? closed.reduce((sum, s) => sum + (s.owedCents ?? 0), 0)
      : null,
    anyClockOpen: stops.some((s) => s.clockOpen),
    freeMinutes,
    freeMinutesAssumed,
    rateCentsPerHour: load.detention_rate_cents_per_hour,
  };
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The claim pack: the plain-text artifact he sends (or Abel drafts
 * from it) when detention is argued — times, terms, math, and the
 * documents that back it. Deliberately text, so it pastes anywhere.
 */
export function buildDetentionClaimPack(input: {
  load: Load;
  stamps: DetentionStamp[];
  documentLabels: string[];
}): string {
  const { load } = input;
  const summary = computeDetention(load, input.stamps);
  const lines: string[] = [
    `Detention claim — ${load.origin} → ${load.destination}`,
    `Terms: ${summary.freeMinutes} free minutes${summary.freeMinutesAssumed ? " (standard assumption — no free time on the rate con)" : " per the rate con"}` +
      (summary.rateCentsPerHour != null ? `, then ${dollars(summary.rateCentsPerHour)}/hour.` : ", rate not on file."),
  ];
  for (const stop of summary.stops) {
    lines.push(
      `${stop.stopKind === "pickup" ? "Pickup" : "Delivery"}: arrived ${fmtTime(stop.arrivalAt)} · door ${fmtTime(stop.doorAt)} · done ${fmtTime(stop.loadingDoneAt)} · departed ${fmtTime(stop.departureAt)}`,
    );
    if (stop.billableMinutes != null) {
      lines.push(
        `  At the facility ${stop.totalMinutes} min; ${stop.billableMinutes} min past free time = ${stop.billableHours} billable hour(s)` +
          (stop.owedCents != null ? ` = ${dollars(stop.owedCents)}.` : " (rate not on file)."),
      );
    } else {
      lines.push("  Clock still open — no departure stamp yet.");
    }
  }
  lines.push(
    summary.totalOwedCents != null
      ? `Total detention owed: ${dollars(summary.totalOwedCents)}.`
      : `Total billable time: ${summary.totalBillableHours} hour(s); money total needs the rate from the rate con.`,
  );
  if (input.documentLabels.length > 0) {
    lines.push(`Backing documents on file: ${input.documentLabels.join("; ")}.`);
  }
  return lines.join("\n");
}
