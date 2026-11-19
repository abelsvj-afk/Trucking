// Smart Path live awareness (owner 2026-11-17): the live-traffic
// poll while driving. The drive page sends the remaining run
// (geometry + corridor timing from his position onward) every two
// minutes; the endpoint answers with the traffic section, the
// ahead-of-time call, and the avoid circles for a one-tap detour —
// but only for about an hour ahead: the corridor is truncated to the
// next 60 minutes of ETAs (100 mi fallback) before TomTom is asked,
// so a long remaining run never costs more than ~2 bbox calls a poll.
// Nothing is stored. TomTom's 2-minute cache (in the integration)
// keeps a 10-hour day to a few hundred calls, well under the free
// tier. When the key is missing or TomTom is down, the section is
// "unavailable" — never invented traffic.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { liveTrafficRequestSchema } from "@/data/schemas/smart-path";
import { buildTrafficSection, truncateToAheadWindow } from "@/services/smart-path/route-traffic";
import {
  avoidCirclesFor,
  evaluateTrafficCall,
  worstDelayAhead,
} from "@/lib/smart-path-traffic";
import { defaultRoutingProvider } from "@/services/integrations/routing";
import type { LiveTrafficResponse } from "@/types/smart-path";

export const POST = createApiHandler(async (req) => {
  const body = await validateBody(req, liveTrafficRequestSchema);
  const now = new Date();
  // Live poll only: about an hour ahead, never the whole remaining run
  // (audit m7 — the TomTom comment used to claim this while the code
  // polled up to 10x60-mi bboxes). The pre-trip route check still sees
  // the whole route; only this poll is windowed.
  const ahead = truncateToAheadWindow({
    geometry: body.geometry,
    corridor: body.corridor,
    totalMiles: body.totalMiles,
    now,
  });
  const traffic = await buildTrafficSection({
    geometry: ahead.geometry,
    totalMiles: ahead.totalMiles,
    corridor: ahead.corridor,
    currentMile: body.currentMile,
    plannedRemainingMinutes: body.plannedRemainingMinutes ?? null,
    now,
  });
  let call = traffic.call;
  const avoidCircles = avoidCirclesFor(traffic.items, ahead.geometry, ahead.totalMiles);
  // The ahead-of-time call, compared against a truck-checked
  // detour — only when a delay is actually coloring the route. A
  // detour that comes back car-only, or a routing failure, leaves
  // the section's own "no detour to compare" call standing.
  if (traffic.status === "ok" && avoidCircles.length > 0) {
    try {
      const detour = await defaultRoutingProvider().getRoute(
        body.currentPoint,
        body.destination,
        body.vehicle ?? null,
        { avoidCircles },
      );
      if (detour.truckLegal) {
        const worst = worstDelayAhead(traffic.items);
        call = evaluateTrafficCall({
          itemsAhead: traffic.items.filter((i) => i.mile >= body.currentMile),
          currentMile: body.currentMile,
          etaAtIncident: worst?.etaAt ?? null,
          detour: { durationMinutes: detour.durationMinutes, distanceMiles: detour.distanceMiles },
          plannedRemainingMinutes: body.plannedRemainingMinutes ?? null,
          now,
        });
      }
    } catch {
      // No detour to compare — the section already says so.
    }
  }
  const response: LiveTrafficResponse = { traffic: { ...traffic, call }, avoidCircles };
  return NextResponse.json(response);
});
