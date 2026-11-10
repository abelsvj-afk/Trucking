// GET /api/v1/roadside/packet (docs/design/eld-roadside-overlay.md).
// The current inspection packet, built server-side from the one HOS read
// (services/roadside/packet-service.ts) - the same bytes the Abel tools
// file, email and drop into Telegram. The /roadside page renders this;
// nothing HOS-shaped is computed in the browser. Session auth, tenant
// from the session.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { buildLivePacket } from "@/services/roadside/packet-service";

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const packet = await buildLivePacket(supabase, ctx.auth.companyId);
  return NextResponse.json({
    data: {
      subject: packet.subject,
      text: packet.text,
      fileName: packet.fileName,
      periodStart: packet.periodStart,
      periodEnd: packet.periodEnd,
    },
  });
});
