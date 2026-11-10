// The active load's NEXT STOP and whether the truck is pulling a trailer (active-load navigation, point 1). Pure.
//  - With stop records (load_stops): the next stop is the first, in sequence, that he has not LEFT (departed_at is null). A stop he
//    has arrived at but not left is still the current stop. Every stop left = no next stop (the load is waiting to be completed).
//  - Without stop records: the load only has its origin and destination text. Nothing records the pickup, so the rule is by date and
//    is labelled as such: before or on the pickup date -> the origin (pickup); after it -> the destination. No pickup date -> origin.
//  - Trailering (owner decision 2026-11-10): the active load has a trailer on it. No trailer on the load = bobtail.

import type { Load, LoadStop } from "@/types/entities";

export interface NextStop {
  /** "stop" = a load_stops record; "load_text" = derived from the load's origin/destination text (no stop records). */
  source: "stop" | "load_text";
  stopId: string | null;
  seq: number | null;
  kind: "pickup" | "delivery" | "other";
  name: string | null;
  /** The text that gets geocoded. */
  address: string;
  appointmentAt: string | null;
  appointmentTz: string | null;
  /** He has tapped "arrived" here and not yet "left". */
  arrived: boolean;
  /** Plain words on how this stop was chosen, when it was not from a stop record. */
  basis: string | null;
}

const day = (value: string | null | undefined): string | null => (value ? value.slice(0, 10) : null);

export function pickNextStop(load: Pick<Load, "origin" | "destination" | "pickup_date">, stops: LoadStop[], todayIso: string): NextStop | null {
  const live = stops.filter((s) => !s.deleted_at).sort((a, b) => a.seq - b.seq);
  if (live.length > 0) {
    const next = live.find((s) => !s.departed_at);
    if (!next) return null;
    const address = (next.address ?? "").trim() || (next.name ?? "").trim();
    if (!address) return null;
    return {
      source: "stop", stopId: next.id, seq: next.seq, kind: next.kind, name: next.name, address,
      appointmentAt: next.appointment_at, appointmentTz: next.appointment_tz, arrived: Boolean(next.arrived_at), basis: null,
    };
  }
  const pickup = day(load.pickup_date);
  const toDestination = pickup !== null && todayIso > pickup;
  const address = (toDestination ? load.destination : load.origin).trim();
  if (!address) return null;
  return {
    source: "load_text", stopId: null, seq: null, kind: toDestination ? "delivery" : "pickup", name: null, address,
    appointmentAt: null, appointmentTz: null, arrived: false,
    basis: toDestination
      ? "This load has no stop records, so I'm using its destination (the pickup date has passed)."
      : "This load has no stop records, so I'm using its origin (the pickup date hasn't passed).",
  };
}

/** Trailering = the active load has a trailer on it (owner decision 2026-11-10). */
export const isTrailering = (load: Pick<Load, "trailer_id">): boolean => Boolean(load.trailer_id);
