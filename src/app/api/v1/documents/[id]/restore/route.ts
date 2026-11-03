// Restore a retention-deleted document (Reliability Unit A / F-007,
// design A.7): clears the tombstone; the retained file never left
// storage, so the document is fully back - same row, same signed URLs.
// Safeguarded like every restore (A.4): if the record the document is
// filed against was itself deleted, restoring is refused with a named
// 422 until the parent is restored first.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound, unprocessableEntity } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import type { Document } from "@/types/entities";

const PARENT_TABLES: Record<string, { table: string; label: string }> = {
  truck: { table: "trucks", label: "truck" },
  trailer: { table: "trailers", label: "trailer" },
  driver: { table: "drivers", label: "driver" },
  load: { table: "loads", label: "load" },
};

export const POST = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();

  const { data: doc, error: fetchError } = await supabase
    .from("documents")
    .select("*")
    .eq("id", ctx.params.id)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!doc) throw notFound();

  const document = doc as Document;
  // Not deleted: nothing to restore - answer with the current state.
  if (document.deleted_at == null) {
    return NextResponse.json(document);
  }

  // Parent safeguard. Documents filed under the company itself (the
  // Telegram intake's convention) have no entity parent to check.
  const parent = PARENT_TABLES[document.related_entity_type];
  if (parent) {
    const { data: parentRow, error: parentError } = await supabase
      .from(parent.table)
      .select("id, deleted_at")
      .eq("id", document.related_entity_id)
      .maybeSingle();
    if (parentError) throw new Error(parentError.message);
    if (!parentRow) {
      throw unprocessableEntity(`Cannot restore: its ${parent.label} no longer exists.`);
    }
    if ((parentRow as { deleted_at: string | null }).deleted_at != null) {
      throw unprocessableEntity(
        `Cannot restore: its ${parent.label} was deleted — restore the ${parent.label} first.`,
      );
    }
  }

  const { data: restored, error: restoreError } = await supabase
    .from("documents")
    .update({ deleted_at: null, retention_status: null, retention_error: null })
    .eq("id", ctx.params.id)
    .not("deleted_at", "is", null)
    .select("*")
    .maybeSingle();

  if (restoreError) throw new Error(restoreError.message);
  if (!restored) throw notFound();
  return NextResponse.json(restored);
});
