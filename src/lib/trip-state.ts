// The trip's REAL state, derived from the load's stop records + pickup completion — never guessed
// (map fix 2026-11-12, owner call 2026-11-11 night).
//
// The bug it replaces: with stop records, the next stop was simply "the first stop not marked
// left" — and a pickup is only marked left when the owner taps "I left" on the load page, which a
// driving owner does not do. So a trip already picked up kept aiming BACK at its pickup ("514
// miles to Kontoor Panama City, past your 14-hour window") while the truck was halfway to the
// delivery. The no-records branch already flipped by pickup window; the with-records branch never
// did.
//
// Rules, stated once here:
//   - The departed_at / arrived_at marks are the truth. A pickup marked left means the freight
//     is on board; an arrived-not-left pickup means the truck is at the pickup now.
//   - A pickup that was NEVER marked left is NOT assumed to be ahead. When the truck is far
//     from it (PICKUP_LEFT_MILES) AND the pickup window has ended, the state is
//     "pickup-unknown": the routing advances past the pickup and SAYS SO (basis text), with
//     what to tap to confirm. The driver corrects it with one tap; the app never silently
//     presents the assumption as fact.
//   - The pickup APPOINTMENT time alone never flips anything: it is a point in time, not a
//     window end. Only the load's pickup_window_end (or the pickup date having passed) counts
//     as the window having ended — a driver 30 mi past the pickup on his way TO it, before
//     the window ends, is still going to the pickup.
//   - No position evidence at all (no distance) means no flip: unknown stays unknown, and the
//     pickup stays the next stop rather than the app inventing a state.

import type { LoadStop } from "@/types/entities";

export type TripState =
  | "not-started"
  | "at-pickup"
  | "picked-up"
  | "en-route-to-delivery"
  | "delivered"
  | "pickup-unknown";

/** Beyond this far from an un-departed pickup, the truck has left the facility behind. */
export const PICKUP_LEFT_MILES = 25;
/** Within this far of the pickup after it is marked left, the truck has only just pulled out. */
export const JUST_LEFT_MILES = 2;

export interface TripStateEvidence {
  /** Miles from the truck to the pickup stop, when known; null = no position evidence. */
  pickupDistanceMiles?: number | null;
}

export interface TripStateResult {
  state: TripState;
  /** Index into the sorted live stops of the effective next stop, or null when there is none. */
  nextIndex: number | null;
  /** True when the routing assumes the pickup is done without a departed_at mark. */
  pickupUnconfirmed: boolean;
  /** Plain words when the state needs explaining (pickup-unknown), else null. */
  basis: string | null;
}

export interface DeriveTripStateInput {
  stops: LoadStop[];
  now: Date;
  /** End of the load's pickup window, ms since epoch; null = no window recorded. */
  pickupWindowEndMs?: number | null;
  /** YYYY-MM-DD pickup date, when recorded. */
  pickupDate?: string | null;
  /** Today's date, YYYY-MM-DD, in the driver's calendar. */
  todayIso?: string | null;
  /** Miles from the truck to the pickup stop, when known. */
  pickupDistanceMiles?: number | null;
}

/** The load's pickup window end as ms since epoch, or null when the load records none. */
export function pickupWindowEndMs(load: { pickup_window_end?: string | null }): number | null {
  if (!load.pickup_window_end) return null;
  const ms = Date.parse(load.pickup_window_end);
  return Number.isFinite(ms) ? ms : null;
}

export function deriveTripState(input: DeriveTripStateInput): TripStateResult {
  const live = [...input.stops].filter((s) => !s.deleted_at).sort((a, b) => a.seq - b.seq);
  if (live.length === 0) return { state: "not-started", nextIndex: null, pickupUnconfirmed: false, basis: null };
  const firstOpen = live.findIndex((s) => !s.departed_at);
  if (firstOpen === -1) return { state: "delivered", nextIndex: null, pickupUnconfirmed: false, basis: null };
  const next = live[firstOpen]!;

  const pickupIdx = live.findIndex((s) => s.kind === "pickup");
  const pickup = pickupIdx >= 0 ? live[pickupIdx]! : null;

  // Freight on board: the pickup is marked left. The next stop decides the leg.
  if (pickup?.departed_at) {
    const state =
      next.kind === "delivery"
        ? input.pickupDistanceMiles != null && input.pickupDistanceMiles > JUST_LEFT_MILES
          ? "en-route-to-delivery"
          : "picked-up"
        : "picked-up";
    return { state, nextIndex: firstOpen, pickupUnconfirmed: false, basis: null };
  }

  if (pickup) {
    if (pickup.arrived_at) return { state: "at-pickup", nextIndex: pickupIdx, pickupUnconfirmed: false, basis: null };
    // Never marked arrived, never marked left. Only position + an ended window may advance past it.
    const windowEnded =
      input.pickupWindowEndMs != null && Number.isFinite(input.pickupWindowEndMs)
        ? input.now.getTime() > input.pickupWindowEndMs
        : input.pickupDate && input.todayIso
          ? input.todayIso > input.pickupDate
          : false;
    const far = input.pickupDistanceMiles != null && input.pickupDistanceMiles > PICKUP_LEFT_MILES;
    if (far && windowEnded) {
      const after = live.findIndex((s, i) => i > pickupIdx && !s.departed_at);
      const pickupName = (pickup.name ?? pickup.address ?? "the pickup").trim() || "the pickup";
      const miles = Math.round(input.pickupDistanceMiles!);
      if (after === -1) {
        return {
          state: "pickup-unknown",
          nextIndex: null,
          pickupUnconfirmed: true,
          basis: `The pickup was never marked left and there is no later stop to aim at — the truck is ${miles} mi from ${pickupName} and the pickup window has ended. Mark the pickup left or add the next stop.`,
        };
      }
      const following = live[after]!;
      return {
        state: "pickup-unknown",
        nextIndex: after,
        pickupUnconfirmed: true,
        basis: `The pickup was never marked left — the truck is ${miles} mi from ${pickupName} and the pickup window has ended, so I'm aiming at the ${following.kind === "delivery" ? "delivery" : "next stop"} instead. Tap 'I left' on the pickup to confirm.`,
      };
    }
    return { state: "not-started", nextIndex: pickupIdx, pickupUnconfirmed: false, basis: null };
  }

  // No pickup stop in the records at all: the next open stop is the next stop.
  return {
    state: next.kind === "delivery" ? "en-route-to-delivery" : "not-started",
    nextIndex: firstOpen,
    pickupUnconfirmed: false,
    basis: null,
  };
}
