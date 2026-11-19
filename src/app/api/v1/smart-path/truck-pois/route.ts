// Drive map (audit-fix B7, 2026-11-18): truck POIs along the run
// while driving. The drive page sends the remaining run (geometry
// from his position onward) when the run starts and after a reroute;
// the endpoint answers with the truck stops, fuel, rest areas, and
// truck parking on it, in miles from his position. Nothing is
// stored. The Overpass 10-minute cache keeps a long day to a few
// calls, well under any fair-use limit. When Overpass is down, the
// section is "unavailable" — never invented stops.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { truckPoisRequestSchema } from "@/data/schemas/smart-path";
import { buildTruckPoisSection } from "@/services/smart-path/route-truck-pois";
import type { TruckPoisResponse } from "@/types/smart-path";

export const POST = createApiHandler(async (req) => {
  const body = await validateBody(req, truckPoisRequestSchema);
  const section = await buildTruckPoisSection({
    geometry: body.geometry,
    totalMiles: body.totalMiles,
    now: new Date(),
  });
  const response: TruckPoisResponse = {
    status: section.status,
    items: section.items,
    notes: section.notes,
    asOf: section.asOf,
  };
  return NextResponse.json(response);
});
