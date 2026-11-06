// POST /api/v1/duty-logs/auto-motion (Block A, docs/design/driver-hud-round2.md).
// The open app asks to switch the log to Driving because the truck has been detected
// moving for a sustained time while the status said otherwise. All rules live in
// services/fleet/auto-motion.ts (shared with the position-feed path that works with the
// app closed): it only ever goes INTO Driving, only ADDS a row from the detection time
// forward, stands down for a manual choice, is idempotent per detection, and honours the
// auto_duty_switch kill switch. Sends the owner a Telegram notice when it switches.
// Paper-log helper, not an ELD.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { applyAutoMotionSwitch, autoSwitchNotice } from "@/services/fleet/auto-motion";
import { createTelegramNotifier } from "@/services/telegram/notify";

const bodySchema = z.object({
  detected_at: z.string().min(1),
  submission_id: z.string().uuid(),
});

export const POST = createApiHandler(async (req: NextRequest, ctx) => {
  const { detected_at, submission_id } = await validateBody(req, bodySchema);
  const supabase = await createClient();
  const result = await applyAutoMotionSwitch({
    client: supabase,
    companyId: ctx.auth.companyId,
    detectedAtIso: detected_at,
    submissionId: submission_id,
    nowMs: Date.now(),
    origin: "app",
  });
  if (result.switched && !result.deduplicated && result.startedAt) {
    // Best-effort: the in-app notice is shown by the caller either way.
    void createTelegramNotifier().notifyOwner(autoSwitchNotice(result.startedAt)).catch(() => false);
  }
  return NextResponse.json({ data: result });
});
