// Smart Path v2 (docs/design/smart-path-v2.md): POST plans the run from what the app knows - the active (or chosen)
// load, its next stop, the truck's position, the stops' appointments, his clocks - with no form to fill.
// Optional body: load_id, depart_at, prefs (food / sleep / workout, remembered on the phone), and this device's fix.
// Computed, nothing stored; RLS + company id scope every read, like route-check.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { runAutoSmartPath } from "@/services/smart-path/auto";

const hour = z.number().int().min(0).max(23);
const autoSchema = z.object({
  load_id: z.string().uuid().nullable().optional(),
  depart_at: z.string().datetime({ offset: true }).nullable().optional(),
  prefs: z
    .object({
      food_mode: z.enum(["grocery", "fast_food"]).optional(),
      sleep_start_hour: hour.optional(),
      sleep_end_hour: hour.optional(),
      workout: z.object({ want: z.boolean(), minutes: z.number().int().min(30).max(180).optional(), setting: z.enum(["gym_preferred", "any_safe_stop"]).optional() }).optional(),
    })
    .optional(),
  position: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      heading: z.number().min(0).max(360).nullable().optional(),
      speed_mph: z.number().min(0).max(150).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const POST = createApiHandler(async (req, ctx) => {
  const body = await validateBody(req, autoSchema);
  const supabase = await createClient();
  const out = await runAutoSmartPath(supabase, ctx.auth.companyId, {
    loadId: body.load_id ?? null,
    departAt: body.depart_at ?? null,
    prefs: body.prefs,
    devicePosition: body.position ? { lat: body.position.lat, lng: body.position.lng, headingDeg: body.position.heading ?? null, speedMph: body.position.speed_mph ?? null } : null,
  });
  return NextResponse.json({ data: out }, { headers: { "Cache-Control": "no-store" } });
});
