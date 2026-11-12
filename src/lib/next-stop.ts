// The active load's NEXT STOP and whether the truck is pulling a trailer (active-load navigation, point 1). Pure.
//  - With stop records (load_stops): the next stop comes from the trip-state model (lib/trip-state.ts). Stop records are the
//    truth: a pickup marked left means the freight is on board; a pickup only counts as done when the owner taps "I left" —
//    UNLESS position evidence plus an ended pickup window says the truck has clearly left the pickup behind, in which case
//    the routing advances past it and SAYS SO (pickupUnconfirmed + basis). Without position evidence, or with the window
//    still open, it does not. Every stop left = no next stop (the load is waiting to be completed).
//  - Without stop records (owner rule 2026-11-10): a pickup marked done always wins - and the only place a pickup is marked done is a
//    stop record, so with none the route stays aimed at the ORIGIN until the pickup appointment window has ENDED, then flips to the
//    destination (flipping at the start of the pickup day could point him at the delivery while the freight is still on the dock).
//    The window end is the load's pickup_window_end; with no window recorded it is the end of the pickup date on the Eastern
//    calendar; with neither it stays on the origin. The state always says which basis it used.
//  - Trailering (owner decision 2026-11-10): the active load has a trailer on it. No trailer on the load = bobtail.

import type { Load, LoadStop } from "@/types/entities";
import { deriveTripState, pickupWindowEndMs, type TripState, type TripStateEvidence } from "@/lib/trip-state";

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
  /** The trip's real state (lib/trip-state.ts) — how the driver got to this next stop. */
  tripState: TripState;
  /** True when the routing assumes the pickup is done without a departed_at mark. */
  pickupUnconfirmed: boolean;
}

const day = (value: string | null | undefined): string | null => (value ? value.slice(0, 10) : null);

export function pickNextStop(
  load: Pick<Load, "origin" | "destination" | "pickup_date" | "pickup_window_end">,
  stops: LoadStop[],
  now: Date,
  todayIso: string,
  evidence?: TripStateEvidence,
): NextStop | null {
  const live = stops.filter((s) => !s.deleted_at).sort((a, b) => a.seq - b.seq);
  if (live.length > 0) {
    const trip = deriveTripState({
      stops: live,
      now,
      pickupWindowEndMs: pickupWindowEndMs(load),
      pickupDate: day(load.pickup_date),
      todayIso,
      pickupDistanceMiles: evidence?.pickupDistanceMiles ?? null,
    });
    if (trip.nextIndex === null) return null;
    const next = live[trip.nextIndex]!;
    const address = (next.address ?? "").trim() || (next.name ?? "").trim();
    if (!address) return null;
    return {
      source: "stop", stopId: next.id, seq: next.seq, kind: next.kind, name: next.name, address,
      appointmentAt: next.appointment_at, appointmentTz: next.appointment_tz, arrived: Boolean(next.arrived_at),
      basis: trip.basis, tripState: trip.state, pickupUnconfirmed: trip.pickupUnconfirmed,
    };
  }
  const windowEndMs = load.pickup_window_end ? Date.parse(load.pickup_window_end) : NaN;
  const pickup = day(load.pickup_date);
  let toDestination: boolean;
  let basis: string;
  if (Number.isFinite(windowEndMs)) {
    toDestination = now.getTime() > windowEndMs;
    basis = toDestination
      ? "This load has no stop records, so I'm aiming at its destination: the pickup appointment window has ended. Add stops and mark the pickup left to control this yourself."
      : "This load has no stop records, so I'm aiming at its origin until the pickup appointment window ends.";
  } else if (pickup !== null) {
    toDestination = todayIso > pickup;
    basis = toDestination
      ? "This load has no stop records or pickup window, so I'm aiming at its destination: the pickup date has passed."
      : "This load has no stop records or pickup window, so I'm aiming at its origin through the end of the pickup date.";
  } else {
    toDestination = false;
    basis = "This load has no stop records, pickup window or pickup date, so I'm aiming at its origin.";
  }
  const address = (toDestination ? load.destination : load.origin).trim();
  if (!address) return null;
  return {
    source: "load_text", stopId: null, seq: null, kind: toDestination ? "delivery" : "pickup", name: null, address,
    appointmentAt: toDestination ? null : (load.pickup_window_end ?? null), appointmentTz: null, arrived: false, basis,
    // No stop records: aiming at the delivery means the pickup is only assumed done.
    tripState: toDestination ? "pickup-unknown" : "not-started", pickupUnconfirmed: toDestination,
  };
}

/** Trailering = the active load has a trailer on it (owner decision 2026-11-10). */
export const isTrailering = (load: Pick<Load, "trailer_id">): boolean => Boolean(load.trailer_id);
