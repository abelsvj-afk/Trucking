// POST /api/v1/position/clocks - the Tracker floating HOS overlay's data
// path (docs/design/eld-roadside-overlay.md). Same device-token discipline
// as the position feed (migration 00073): NOT session-authenticated, the
// shell presents "Authorization: Bearer tdv_...", the route fails closed
// with the same generic 401, rate-limits per token, and scopes to the
// token's company. READ-ONLY: it returns the four HOS clocks computed by
// the ONE server-side HOS read (loadHosWindow + computeHudClocks) - the
// phone never computes HOS, it displays what the server states.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/device-token";
import { authenticateDeviceToken, rateLimited } from "@/services/fleet/device-feed";
import { loadHosWindow, toWindowSummary } from "@/services/api/hos-window";
import { computeHudClocks } from "@/lib/hud-clocks";

const unauthorized = () => NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } }, { status: 401 });

export async function POST(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return unauthorized();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Clocks are not configured." } }, { status: 503 });
  const client = createClient(url, key);

  const nowMs = Date.now();
  const device = await authenticateDeviceToken(client, token, nowMs);
  if (!device) return unauthorized();
  if (rateLimited(device.tokenId, nowMs)) {
    return NextResponse.json({ error: { code: "RATE_LIMITED", message: "Too many requests." } }, { status: 429, headers: { "Retry-After": "30" } });
  }

  const now = new Date(nowMs);
  const snapshot = await loadHosWindow(client, device.companyId, now);
  const clocks = computeHudClocks(snapshot.rows, toWindowSummary(snapshot), nowMs);
  if (clocks.state === "no-logs") {
    // Honest empty state: no duty logs yet - the overlay shows "no logs"
    // rather than invented clocks, exactly like every other surface.
    return NextResponse.json({ data: { state: "no-logs", status: null, statusSince: null, cycleUnavailable: false, computedAt: now.toISOString(), clocks: [] } });
  }
  return NextResponse.json({
    data: {
      state: clocks.state,
      status: clocks.status,
      statusSince: new Date(clocks.statusSinceMs).toISOString(),
      cycleUnavailable: clocks.cycleUnavailable,
      computedAt: now.toISOString(),
      clocks: clocks.clocks.map((c) => ({ key: c.key, label: c.label, remainingMs: c.remainingMs, totalMs: c.totalMs, tone: c.tone })),
    },
  });
}
