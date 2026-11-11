// GET /api/v1/active-load - the current active load, its next stop and the route to it from the truck (active-load navigation).
// The SAME builder Abel's active_load_status tool calls (services/navigation/active-load-state.ts), so the map and Abel cannot disagree.
// Optional ?lat=&lng=&heading=&speed= is THIS device's current fix; without it the newest Tracker / Telegram position is used.
// Read-only; session-authenticated like every v1 route; company-scoped. Times are instants - the UI shows them in Eastern time.

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { buildActiveLoadState } from "@/services/navigation/active-load-state";

const num = (value: string | null): number | null => {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

export const GET = createApiHandler(async (req: NextRequest, ctx) => {
  const q = new URL(req.url).searchParams;
  const lat = num(q.get("lat"));
  const lng = num(q.get("lng"));
  const heading = num(q.get("heading"));
  const speed = num(q.get("speed"));
  if ((lat === null) !== (lng === null)) throw validationError("lat and lng must be sent together.");
  if (lat !== null && lng !== null && (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180)) {
    throw validationError("lat/lng are not a valid position.");
  }
  if ((heading !== null && (Number.isNaN(heading) || heading < 0 || heading > 360)) || (speed !== null && (Number.isNaN(speed) || speed < 0 || speed > 150))) {
    throw validationError("heading/speed are not valid.");
  }
  const supabase = await createClient();
  const state = await buildActiveLoadState(supabase, ctx.auth.companyId, {
    devicePosition: lat !== null && lng !== null ? { lat, lng, headingDeg: heading, speedMph: speed } : null,
  });
  return NextResponse.json({ data: state }, { headers: { "Cache-Control": "no-store" } });
});
