// Duty-log CRUD options (UI/UX spec 2026-11-10 §2.2): the edit-trail
// write path shared by the duty-logs collection route, the [id] route,
// and the restore route. The generic factory (crud-routes.ts) stays
// generic - everything duty-specific lives here:
//
// - edit_reason / edit_source are META fields: prepareCreate /
//   prepareUpdate strip them from every write payload, so they never
//   land as duty_logs columns (they live on the duty_log_edits row).
// - PATCH: validateMerged refuses (422) any substantive patch - one
//   carrying an actual duty field - that brings no reason. A patch of
//   only meta fields is not a correction and is not refused.
// - afterWrite: with a reason present, records the trail row -
//   kind 'update' (before = the row as loaded, after = the row as
//   written) for PATCH, kind 'insert' (before = null) for POST.
//   Creates WITHOUT a reason are live logging (or an offline-outbox
//   replay) and write no trail row - the collection route's own guard
//   is what refuses an unexplained BACKDATED create.

import type { CrudRouteOptions } from "./crud-routes";
import { unprocessableEntity, type ApiError } from "./errors";
import { recordDutyLogEdit } from "@/services/duty-log-edits";
import type { DutyLogEditSource } from "@/types/entities";

export const REASON_REQUIRED_MESSAGE = "A reason is required to correct a duty entry.";

export const BACKFILL_REASON_MESSAGE =
  "A reason is required to add a duty entry in the past. Say why you're adding it - for example, \"Forgot to log it\".";

/** A create whose started_at is older than this is a backfill (a correction), not live logging. */
export const BACKFILL_THRESHOLD_MS = 15 * 60_000;

/** The fields whose presence makes a PATCH a correction of the entry. */
const DUTY_FIELDS = ["driver_id", "load_id", "duty_status", "started_at", "location", "odometer", "notes"] as const;

export function editReasonFrom(source: Record<string, unknown> | undefined): string | null {
  const raw = source?.edit_reason;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export function editSourceFrom(source: Record<string, unknown> | undefined): DutyLogEditSource {
  const raw = source?.edit_source;
  return raw === "conversation" || raw === "paper" ? raw : "app";
}

function stripEditMeta(body: Record<string, unknown>): Record<string, unknown> {
  const { edit_reason: _reason, edit_source: _source, ...rest } = body;
  void _reason;
  void _source;
  return rest;
}

export const dutyLogCrudOptions: CrudRouteOptions = {
  validateMerged: (_merged, _existing, patch): ApiError | null => {
    const substantive = DUTY_FIELDS.some((field) => patch[field] !== undefined);
    if (substantive && !editReasonFrom(patch)) {
      return unprocessableEntity(REASON_REQUIRED_MESSAGE);
    }
    return null;
  },
  prepareCreate: (body) => stripEditMeta(body),
  prepareUpdate: (_merged, patch) => stripEditMeta(patch),
  afterWrite: async ({ supabase, companyId, kind, id, before, after, rawBody, rawPatch }) => {
    if (kind === "create") {
      const reason = editReasonFrom(rawBody);
      if (!reason) return; // live logging / outbox replay - no trail row
      await recordDutyLogEdit(supabase, {
        companyId,
        dutyLogId: id,
        kind: "insert",
        reason,
        before: null,
        after,
        source: editSourceFrom(rawBody),
      });
      return;
    }
    const reason = editReasonFrom(rawPatch);
    if (!reason) return;
    // A patch carrying only meta fields changed nothing - no trail row
    // for a non-correction (mirrors validateMerged's substantive test).
    if (!DUTY_FIELDS.some((field) => rawPatch?.[field] !== undefined)) return;
    await recordDutyLogEdit(supabase, {
      companyId,
      dutyLogId: id,
      kind: "update",
      reason,
      before,
      after,
      source: editSourceFrom(rawPatch),
    });
  },
};
