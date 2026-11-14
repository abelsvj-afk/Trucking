// POST /api/v1/duty-logs/auto-stop (ELD stopped vehicle, App. A §4.4.1.2).
// The open app asks to switch the log to On Duty Not Driving because
// the truck has been stopped for 6 minutes and the 5-minute prompt went
// unanswered. All rules live in services/fleet/auto-motion.ts (shared
// with the position-feed path that works with the app closed): it only
// ever ADDS an On Duty row backdated to the stop start, never edits or
// deletes anything, never auto-switches to Off Duty/Sleeper, stands
// down for a manual choice or when never prompted, is idempotent per
// stop episode, and honours the auto_duty_switch kill switch. Sends
// the owner a Telegram notice when it switches. Paper-log helper,
// not an ELD.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { applyAutoStopSwitch } from "@/services/fleet/auto-motion";
import { loadDisplayZone } from "@/lib/display-zone";
import { createTelegramNotifier } from "@/services/telegram/notify";

const bodySchema = z.object({
  stopped_since: z.string().min(1),
  submission_id: z.string().uuid(),
  /** When the 5-minute prompt was shown for this episode (ms since epoch) — null/absent means never prompted: the server refuses. */
  prompted_at_ms: z.number().int().nonnegative().nullable().optional(),
});

export const POST = createApiHandler(async (req: NextRequest, ctx) => {
  const { stopped_since, submission_id, prompted_at_ms } = await validateBody(req, bodySchema);
  const supabase = await createClient();
  // The open app posts a stop, not a fix: the zone comes from
  // the latest stored position (either feed), home Eastern fallback.
  const displayZone = await loadDisplayZone(supabase, ctx.auth.companyId);
  const result = await applyAutoStopSwitch({
    client: supabase,
    companyId: ctx.auth.companyId,
    stoppedSinceIso: stopped_since,
    submissionId: submission_id,
    nowMs: Date.now(),
    promptedAtMs: prompted_at_ms ?? null,
    origin: "app",
    timeZone: displayZone.timeZone,
  });
  if (result.switched && !result.deduplicated && result.message) {
    // Best-effort: the in-app notice is shown by the caller either way.
    void createTelegramNotifier().notifyOwner(result.message).catch(() => false);
  }
  return NextResponse.json({ data: result });
});
