// POST /api/v1/paper-logs/{documentId}/save - turns his reviewed day
// into duty rows, atomically (save_paper_log_day, migration 00059).
// The whole 00:00-24:00 day must be covered by statuses he confirmed
// (lib/paper-day.ts validateDraft, re-run here - the client is never
// trusted). Existing entries inside the day are replaced only when he
// listed them in replace_ids; otherwise 409.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { ApiError, notFound, unprocessableEntity, validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { loadHosConfig } from "@/services/api/hos-config";
import { savePaperLogDay } from "@/services/fleet/paper-log-review";
import { dutyStatusSchema } from "@/data/schemas/duty-logs";

const saveBodySchema = z.object({
  log_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  segments: z
    .array(
      z.object({
        status: dutyStatusSchema,
        start_min: z.number().int().min(0).max(1440),
        end_min: z.number().int().min(0).max(1440),
      }),
    )
    .min(1)
    .max(200),
  replace_ids: z.array(z.string().uuid()).max(500),
});

export const POST = createApiHandler(async (req, ctx) => {
  const id = z.string().uuid().safeParse(ctx.params.id);
  if (!id.success) throw notFound();
  const parsed = saveBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw validationError("The day couldn't be read from the request.");
  const supabase = await createClient();
  const { config } = await loadHosConfig(supabase, ctx.auth.companyId);
  const outcome = await savePaperLogDay(supabase, ctx.auth.companyId, id.data, config.carrierTimeZone, parsed.data);
  if (outcome.ok) return NextResponse.json({ data: { inserted: outcome.inserted } });
  if (outcome.kind === "not_found") throw notFound();
  if (outcome.kind === "conflict") {
    throw new ApiError(
      409,
      "PAPER_LOG_CONFLICT",
      "This day already has entries that weren't marked for replacement. Reload the review and choose whether the paper replaces them.",
    );
  }
  throw unprocessableEntity(outcome.errors.join(" "));
});
