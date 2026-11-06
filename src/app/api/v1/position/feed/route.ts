// POST /api/v1/position/feed - the native background-tracking shell reports the truck's position
// here with the app closed (docs/design/background-tracking.md, Path 2). NOT session-authenticated:
// the shell has no browser cookie, so it presents a device token ("Authorization: Bearer tdv_...",
// migration 00073) and proxy.ts lists this one path as public. The route fails closed on a missing,
// malformed, unknown or revoked token with the same generic 401, rate-limits per token, validates
// the body, and scopes everything to the token's company in code.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/device-token";
import { applyAutoMotionSwitch } from "@/services/fleet/auto-motion";
import { authenticateDeviceToken, feedBodySchema, normalizeFixes, rateLimited } from "@/services/fleet/device-feed";
import { createBrainLiveLocationStore, handleLiveLocation } from "@/services/telegram/live-location";
import { createTelegramNotifier } from "@/services/telegram/notify";
import { createTelegramBrainStore } from "@/services/telegram/store";

const unauthorized = () => NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } }, { status: 401 });

export async function POST(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return unauthorized();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Position feed is not configured." } }, { status: 503 });
  const client = createClient(url, key);

  const nowMs = Date.now();
  const device = await authenticateDeviceToken(client, token, nowMs);
  if (!device) return unauthorized();
  if (rateLimited(device.tokenId, nowMs)) {
    return NextResponse.json({ error: { code: "RATE_LIMITED", message: "Too many requests." } }, { status: 429, headers: { "Retry-After": "30" } });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Body must be JSON." } }, { status: 400 });
  }
  const parsed = feedBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Body must be { fixes: [{ lat, lng, at, ... }] } with 1-60 valid fixes." } }, { status: 400 });
  }
  const { usable, dropped } = normalizeFixes(parsed.data.fixes, nowMs);

  const brain = createTelegramBrainStore(device.companyId);
  if (!brain) return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Position feed is not configured." } }, { status: 503 });
  // The live_location switch (default on; explicit off stops storage and proposals).
  if (!(await brain.isLiveLocationEnabled())) {
    return NextResponse.json({ data: { accepted: 0, dropped: usable.length + dropped, reason: "switched_off" } });
  }

  const notifier = createTelegramNotifier();
  const store = createBrainLiveLocationStore(brain, "device");
  let accepted = 0;
  for (const fix of usable) {
    try {
      const res = await handleLiveLocation(store, fix.loc, fix.atMs, {
        sendMessage: async (text) => void (await notifier.notifyOwner(text)),
        formatTime: (t) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(t)),
        autoSwitch: (detectedAtIso, submissionId) =>
          applyAutoMotionSwitch({ client, companyId: device.companyId, detectedAtIso, submissionId, nowMs: Date.now(), origin: "position feed" }),
      });
      if (res.kind === "recorded") accepted += 1;
    } catch (err) {
      console.error("[position-feed] fix failed", err);
    }
  }
  return NextResponse.json({ data: { accepted, dropped: dropped + (usable.length - accepted) } });
}

