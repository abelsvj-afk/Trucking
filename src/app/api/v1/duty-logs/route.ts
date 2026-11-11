import { NextRequest, NextResponse } from "next/server";
import { createCrudRoutes } from "@/services/api/crud-routes";
import { createDutyLogSchema, updateDutyLogSchema } from "@/data/schemas/duty-logs";
import {
  BACKFILL_REASON_MESSAGE,
  BACKFILL_THRESHOLD_MS,
  dutyLogCrudOptions,
  editReasonFrom,
} from "@/services/api/duty-log-options";
import type { DutyLog } from "@/types/entities";

// UI/UX upgrade: filterableFields: ["load_id"] lets the load detail
// screen count exactly this load's duty entries - same reasoning as
// expenses (the column existed; the whitelist didn't).
//
// Edit trail (spec §2.2): the shared dutyLogCrudOptions strip the
// edit_reason/edit_source meta fields and record kind='insert' trail
// rows for creates that carry a reason. The POST wrapper below adds
// the one rule the factory can't see (it never looks at submission_id
// in hooks): a BACKDATED create (>15 minutes in the past) with no
// reason and no submission_id is refused 422 - it is a correction
// with no explanation. Live logging is untouched: a create for ~now
// needs no reason, and every first-party form (StatusSheet, HUD,
// hos/new) plus every offline-outbox replay carries a submission_id,
// which is the replay distinguisher - a replayed backfill keeps its
// original started_at and must not be refused for lacking a reason
// it never had. Auto-motion uses its own route and is untouched.
const routes = createCrudRoutes<DutyLog>(
  "duty_logs",
  {
    create: createDutyLogSchema,
    update: updateDutyLogSchema,
  },
  { filterableFields: ["load_id"], ...dutyLogCrudOptions },
);

export const GET = routes.list;

export const POST = async (
  req: NextRequest,
  ctx?: { params: Promise<Record<string, string>> },
): Promise<NextResponse> => {
  let raw: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await req.clone().json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    raw = null; // unparseable body: the factory answers its usual 400
  }
  if (raw) {
    const startedMs = typeof raw.started_at === "string" ? Date.parse(raw.started_at) : NaN;
    const hasSubmissionId = typeof raw.submission_id === "string" && raw.submission_id.length > 0;
    if (
      Number.isFinite(startedMs) &&
      Date.now() - startedMs > BACKFILL_THRESHOLD_MS &&
      !editReasonFrom(raw) &&
      !hasSubmissionId
    ) {
      return NextResponse.json(
        { error: { code: "UNPROCESSABLE_ENTITY", message: BACKFILL_REASON_MESSAGE } },
        { status: 422 },
      );
    }
  }
  return routes.create(req, ctx);
};
