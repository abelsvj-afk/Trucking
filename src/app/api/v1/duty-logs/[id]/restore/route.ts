import { NextRequest, NextResponse } from "next/server";
import { createCrudRoutes } from "@/services/api/crud-routes";
import { createDutyLogSchema, updateDutyLogSchema } from "@/data/schemas/duty-logs";
import { createClient } from "@/services/db/server";
import { editSourceFrom } from "@/services/api/duty-log-options";
import { recordDutyLogEdit } from "@/services/duty-log-edits";
import type { DutyLog } from "@/types/entities";

const routes = createCrudRoutes<DutyLog>("duty_logs", {
  create: createDutyLogSchema,
  update: updateDutyLogSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
//
// Edit trail (spec §2.2): the factory restore is WRAPPED, not changed.
// A restore that actually transitions a deleted entry back writes a
// kind='restore' trail row (before = null, after = the restored row).
// The reason is the caller's edit_reason when one rides along, else
// "Entry restored" - restoring undoes a delete that already carried
// its own reason, and the generic RecordLifecycle component restores
// with no body at all; that path must keep working. A restore call on
// an entry that isn't deleted changes nothing and writes no trail row.
export const POST = async (
  req: NextRequest,
  routeCtx: { params: Promise<Record<string, string>> } = { params: Promise.resolve({}) },
): Promise<NextResponse> => {
  const params = await routeCtx.params.catch(() => ({}) as Record<string, string>);
  const id = params.id;

  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = await req.clone().json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    meta = {}; // no body (RecordLifecycle) - the default reason applies
  }

  // Was this entry actually deleted before the call? Only a real
  // deleted -> live transition earns a trail row.
  let wasDeleted = false;
  if (id) {
    try {
      const supabase = await createClient();
      const { data } = await supabase
        .from("duty_logs")
        .select("deleted_at")
        .eq("id", id)
        .maybeSingle();
      wasDeleted = data != null && (data as { deleted_at: string | null }).deleted_at != null;
    } catch {
      wasDeleted = false;
    }
  }

  const res = await routes.restore(req, routeCtx);
  if (id && wasDeleted && res.status === 200) {
    try {
      const restored = (await res.clone().json()) as Record<string, unknown> | null;
      if (restored && restored.deleted_at == null) {
        const supabase = await createClient();
        const reason =
          typeof meta.edit_reason === "string" && meta.edit_reason.trim().length > 0
            ? meta.edit_reason.trim()
            : "Entry restored";
        await recordDutyLogEdit(supabase, {
          companyId: typeof restored.company_id === "string" ? restored.company_id : "",
          dutyLogId: id,
          kind: "restore",
          reason,
          before: null,
          after: restored,
          source: editSourceFrom(meta),
        });
      }
    } catch (err) {
      // The restore itself landed; a trail failure never un-restores it.
      console.error("[duty-logs restore] trail write failed:", err);
    }
  }
  return res;
};
