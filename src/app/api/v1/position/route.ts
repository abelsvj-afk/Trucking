// GET /api/v1/position - the latest position Telegram Live Location sent
// (docs/design/driver-usability.md §4). Returns { position: null } when
// nothing has been shared; otherwise the fix plus its AGE in seconds so the
// caller can refuse to treat an old fix as "now". Company-scoped by RLS.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { LIVE_LOCATION_CAPABILITY } from "@/lib/live-motion";

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  // The live_location switch (default on; an explicit off row stops it).
  const [globalRow, switchRow] = await Promise.all([
    supabase.from("companies").select("ai_globally_disabled").eq("id", ctx.auth.companyId).single(),
    supabase.from("ai_capability_settings").select("enabled").eq("company_id", ctx.auth.companyId).eq("capability", LIVE_LOCATION_CAPABILITY).maybeSingle(),
  ]);
  const off =
    globalRow.error ||
    switchRow.error ||
    (globalRow.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled === true ||
    (switchRow.data as { enabled: boolean } | null)?.enabled === false;
  if (off) return NextResponse.json({ position: null }, { headers: { "Cache-Control": "no-store" } });
  const { data, error } = await supabase
    .from("driver_positions")
    .select("lat, lng, accuracy_m, heading_deg, speed_mph, recorded_at")
    .eq("company_id", ctx.auth.companyId)
    .eq("source", "telegram")
    .maybeSingle();
  // Before migration 00060 the table is absent: say "no position", never fail the page.
  if (error || !data) return NextResponse.json({ position: null }, { headers: { "Cache-Control": "no-store" } });
  const r = data as { lat: number; lng: number; accuracy_m: number | null; heading_deg: number | null; speed_mph: number | null; recorded_at: string };
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(r.recorded_at)) / 1000));
  return NextResponse.json(
    {
      position: {
        lat: r.lat, lng: r.lng, accuracyM: r.accuracy_m, headingDeg: r.heading_deg,
        speedMph: r.speed_mph, recordedAt: r.recorded_at, ageSeconds,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
