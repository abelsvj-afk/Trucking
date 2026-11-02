// No GET/PATCH here - docs/api-contracts.md's documents contract only
// defines list (with a filter), create, delete, and (Unit A) restore.
//
// DELETE is a RETENTION delete (Reliability Unit A / F-007, design
// A.7): the row is tombstoned (deleted_at + retention_status) and the
// stored files are RETAINED - this handler never calls
// storage.remove(). The pre-Unit-A behavior hard-deleted the row and
// removed the files, which made deleting legal/financial paperwork
// (settlements, BOLs, CDLs) irreversible; that failure mode is what
// D-05 ruled out. Actual file removal belongs to a future purge
// process under an owner-approved retention policy - not to this
// endpoint, and not to deletion.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";

export const DELETE = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("documents")
    .update({
      deleted_at: new Date().toISOString(),
      retention_status: "retained",
      retention_error: null,
    })
    .eq("id", ctx.params.id)
    .is("deleted_at", null)
    .select("id");

  if (error) throw new Error(error.message);
  // Truthful delete (F-005 semantics, applied to documents): deleting
  // a nonexistent, already-deleted, or other-company document is a
  // 404, not a silent 204.
  if (!data || data.length === 0) throw notFound();

  return new NextResponse(null, { status: 204 });
});
