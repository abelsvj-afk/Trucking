import { NextResponse } from "next/server";
import { createCrudRoutes } from "@/services/api/crud-routes";
import { createApiHandler } from "@/services/api/handler";
import { notFound, unprocessableEntity } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { createDutyLogSchema, updateDutyLogSchema } from "@/data/schemas/duty-logs";
import {
  REASON_REQUIRED_MESSAGE,
  dutyLogCrudOptions,
  editSourceFrom,
} from "@/services/api/duty-log-options";
import { fetchDutyLogEdits, recordDutyLogEdit } from "@/services/duty-log-edits";
import type { DutyLog } from "@/types/entities";

// Edit trail (spec §2.2): PATCH runs through the factory with the
// shared duty options (reason required via validateMerged, meta
// fields stripped, kind='update' trail row via afterWrite). GET and
// DELETE are custom - see below.
const routes = createCrudRoutes<DutyLog>(
  "duty_logs",
  {
    create: createDutyLogSchema,
    update: updateDutyLogSchema,
  },
  dutyLogCrudOptions,
);

export const PATCH = routes.update;

// GET one entry PLUS its edit trail (spec §2.2 read path): the row's
// own fields at the top level (unchanged shape for existing callers),
// with edits: [...] added - trail rows for this entry, edited_at
// ascending. 404 semantics identical to the factory's getOne.
export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const id = ctx.params.id!;
  const { data: row, error } = await supabase
    .from("duty_logs")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw notFound();
  const edits = await fetchDutyLogEdits(supabase, id);
  return NextResponse.json({ ...(row as Record<string, unknown>), edits });
});

// DELETE with a required reason (spec §2.2): replicates the factory
// remove's semantics - RLS-scoped fetch (absent or another company's
// row is a 404 before anything else), soft delete (no affected row is
// a 404, never a silent 204) - and adds the trail: the reason comes
// from the JSON body when present, else the ?edit_reason= query param;
// without one the delete is refused 422 and nothing is deleted. A
// successful delete writes kind='delete' (before = the row, after =
// null) so the entry's history survives its removal.
export const DELETE = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const id = ctx.params.id!;

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null; // no body - the query param may still carry the reason
  }
  const url = new URL(req.url);
  const reasonRaw =
    typeof body?.edit_reason === "string" && body.edit_reason.trim().length > 0
      ? body.edit_reason
      : url.searchParams.get("edit_reason");
  const sourceRaw = {
    edit_source:
      typeof body?.edit_source === "string" ? body.edit_source : url.searchParams.get("edit_source"),
  };

  const { data: existing, error } = await supabase
    .from("duty_logs")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!existing) throw notFound();

  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  if (!reason) throw unprocessableEntity(REASON_REQUIRED_MESSAGE);

  const { data: deleted, error: deleteError } = await supabase
    .from("duty_logs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (deleteError) throw deleteError;
  if (!deleted || (deleted as unknown[]).length === 0) throw notFound();

  await recordDutyLogEdit(supabase, {
    companyId: ctx.auth.companyId,
    dutyLogId: id,
    kind: "delete",
    reason,
    before: existing as Record<string, unknown>,
    after: null,
    source: editSourceFrom(sourceRaw),
  });
  return new NextResponse(null, { status: 204 });
});
