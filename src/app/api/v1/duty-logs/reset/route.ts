// POST /api/v1/duty-logs/reset - the MANUAL clock reset (owner
// 2026-11-17). Never automatic, never triggered by anything else:
// the driver presses "Reset clocks" on the Home clocks and confirms
// once, and this route runs.
//
// What it does: records the reset as a correction event in the edit
// trail (services/duty-log-edits.ts recordClockReset) on the latest
// duty entry, with a reason and the reset instant. The original duty
// rows are NEVER changed - the HOS engine reads the latest trail
// marker back and RE-DERIVES the short clocks from the log of the
// day the reset was pressed on (DAY-AWARE, owner 2026-11-17):
// driving already done that day still counts against the 11,
// on-duty time already used still counts against the 14, and breaks
// and stops already taken that day still count, including a
// qualifying rest period that could still pair for a split. The
// reset fixes a wrong derivation/anchor; it does not hand him a
// fresh day he has not earned, and it takes effect immediately - no
// rest period to wait out. The weekly 60/70-hour cycle is NOT reset
// (only 34 hours off resets it, § 395.3(c)) - if the cycle itself
// is wrong, the underlying log entries are fixed through the
// existing edit path instead.
//
// Honest limit: if the underlying log ENTRIES themselves are wrong
// (bad auto-switch entries), re-deriving from the same log will not
// fix the clocks - those entries get fixed via the existing
// duty-log edit path, not by this reset.
//
// No migration: the reset rides the existing duty_log_edits table
// (00088) - see CLOCK_RESET_AT in services/duty-log-edits.ts.
// Paper-log helper, not an ELD.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { ApiError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { recordClockReset } from "@/services/duty-log-edits";
import type { DutyLog } from "@/types/entities";

const bodySchema = z.object({
  /** Optional reason, shown in the edit history. Defaults to the plain-language reset reason. */
  reason: z.string().trim().min(1).max(500).optional(),
});

export const DEFAULT_RESET_REASON =
  "Clocks reset by hand - re-derived from today's log, so today's driving and breaks still count. The weekly cycle was not reset.";

export const POST = createApiHandler(async (req: NextRequest, ctx) => {
  const { reason } = await validateBody(req, bodySchema);
  const supabase = await createClient();
  const resetAt = new Date();

  // The trail row anchors to the latest duty entry - the reset is
  // visible in that entry's edit history. With no logs at all there
  // are no clocks to reset.
  const { data, error } = await supabase
    .from("duty_logs")
    .select("*")
    .eq("company_id", ctx.auth.companyId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    throw new ApiError(500, "CLOCK_RESET_UNAVAILABLE", "The duty log could not be loaded, so the clocks were not reset.");
  }
  const latest = (data ?? [])[0] as unknown as DutyLog | undefined;
  if (!latest) {
    throw new ApiError(422, "CLOCK_RESET_NO_LOGS", "There are no duty logs yet, so there are no clocks to reset.");
  }

  const ok = await recordClockReset(supabase, {
    companyId: ctx.auth.companyId,
    dutyLog: latest,
    resetAtIso: resetAt.toISOString(),
    reason: reason ?? DEFAULT_RESET_REASON,
  });
  if (!ok) {
    throw new ApiError(500, "CLOCK_RESET_UNAVAILABLE", "The reset could not be recorded, so the clocks were not reset.");
  }
  return NextResponse.json({ data: { resetAt: resetAt.toISOString(), dutyLogId: latest.id } });
});
