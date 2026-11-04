// Spoken turn instructions for Drive Mode (audit D5, 2026-11-04). Pure.
// A maneuver is announced at most twice: once about half a mile out and
// once close in. A maneuver first seen already close announces only the
// close one (never a stale "in half a mile" when he is at the turn), and
// nothing repeats. The instruction text is the routing provider's own;
// this adds only the distance lead-in.

import type { RouteManeuver } from "@/services/integrations/routing";

export const FAR_MILES = 0.6;
export const NEAR_MILES = 0.15;

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

const keyOf = (m: RouteManeuver, tier: "far" | "near") => `${m.atFraction.toFixed(6)}:${m.instruction}:${tier}`;

export function maneuverAnnouncement(
  upcoming: UpcomingManeuver | null,
  spoken: ReadonlySet<string>,
): ManeuverAnnouncement | null {
  if (!upcoming) return null;
  const { maneuver, milesAway } = upcoming;
  const text = maneuver.instruction.replace(/[.\s]+$/, "");
  if (!text) return null;
  const near = keyOf(maneuver, "near");
  const far = keyOf(maneuver, "far");

  if (milesAway <= NEAR_MILES) {
    if (spoken.has(near)) return null;
    // Close in: say it plainly, and consume the far tier too.
    return { keys: [near, far], line: `${text}.` };
  }
  if (milesAway <= FAR_MILES) {
    if (spoken.has(far)) return null;
    return { keys: [far], line: `In ${distanceWords(milesAway)}, ${text.charAt(0).toLowerCase()}${text.slice(1)}.` };
  }
  return null;
}
