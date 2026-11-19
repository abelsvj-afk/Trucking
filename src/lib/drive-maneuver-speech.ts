// Spoken turn instructions for Drive Mode (audit D5, 2026-11-04). Pure.
// A maneuver is announced at most three times: once on the approach
// (audit-fix B7, 2026-11-18 — about four and a half miles out, turns
// and exits only, so he hears it coming while the map is zooming in),
// once about half a mile out and once close in. A maneuver first seen
// already close announces only the close one (never a stale "in half
// a mile" when he is at the turn), and nothing repeats. The
// instruction text is the routing provider's own; this adds only the
// distance lead-in.

import type { RouteManeuver } from "@/services/integrations/routing";
import { maneuverDirection } from "./drive";
import { maneuverZoomProfile } from "./drive-maneuver-zoom";

export const FAR_MILES = 0.6;
export const NEAR_MILES = 0.15;
/** The approach call-out fires as the zoom starts (drive-maneuver-zoom.ts:
 * ~4.5 mi for a highway exit, ~1.5 mi for a street turn), once, inside a
 * band this deep below that start — never a stale early call. */
export const APPROACH_BAND_MILES = 0.5;

export interface UpcomingManeuver {
  maneuver: RouteManeuver;
  milesAway: number;
}

export interface ManeuverAnnouncement {
  /** Marks the tiers consumed so they aren't announced again. */
  keys: string[];
  line: string;
}

function distanceWords(miles: number): string {
  if (miles >= 0.9) return `${miles.toFixed(1)} miles`;
  if (miles >= 0.4) return "half a mile";
  return "a quarter mile";
}

const keyOf = (m: RouteManeuver, tier: "approach" | "far" | "near") => `${m.atFraction.toFixed(6)}:${m.instruction}:${tier}`;

export function maneuverAnnouncement(
  upcoming: UpcomingManeuver | null,
  spoken: ReadonlySet<string>,
): ManeuverAnnouncement | null {
  if (!upcoming) return null;
  const { maneuver, milesAway } = upcoming;
  const text = maneuver.instruction.replace(/[.\s]+$/, "");
  if (!text) return null;
  const direction = maneuverDirection(maneuver.instruction);
  const near = keyOf(maneuver, "near");
  const far = keyOf(maneuver, "far");
  const approach = keyOf(maneuver, "approach");

  if (milesAway <= NEAR_MILES) {
    if (spoken.has(near)) return null;
    // Close in: say it plainly, and consume the far tier too.
    return { keys: [near, far], line: `${text}.` };
  }
  if (milesAway <= FAR_MILES) {
    if (spoken.has(far)) return null;
    return { keys: [far], line: `In ${distanceWords(milesAway)}, ${text.charAt(0).toLowerCase()}${text.slice(1)}.` };
  }
  // The approach: a turn or exit a few miles out gets one early
  // call-out ("in about four and a half miles, take exit ...") so
  // the voice walks him into the zoom. Straight-ahead never gets
  // one — "stay on the road" four miles early is noise — and the
  // band keeps it a single crossing: a maneuver first seen inside
  // the band still announces, one first seen below it does not get
  // a stale early call.
  const profile = maneuverZoomProfile(maneuver.instruction, direction);
  if (
    profile &&
    milesAway <= profile.startMiles &&
    milesAway >= profile.startMiles - APPROACH_BAND_MILES &&
    !spoken.has(approach)
  ) {
    return { keys: [approach], line: `In ${distanceWords(milesAway)}, ${text.charAt(0).toLowerCase()}${text.slice(1)}.` };
  }
  return null;
}
