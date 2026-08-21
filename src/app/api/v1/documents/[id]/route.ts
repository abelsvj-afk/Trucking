// No GET/PATCH here - docs/api-contracts.md's documents contract only
// defines list (with a filter), create, and a hard delete. A single-row
// GET isn't part of the documented contract and would be dead code.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";

export const DELETE = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();

  const { data: doc, error: fetchError } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("id", ctx.params.id)
    .maybeSingle();

  if (fetchError || !doc) throw notFound();

  const { error: deleteRowError } = await supabase.from("documents").delete().eq("id", ctx.params.id);
  if (deleteRowError) throw new Error(deleteRowError.message);

  // Row is gone either way; a failure to also remove the file leaves an
  // orphaned object rather than a broken document - acceptable since it's
  // no longer reachable through the app.
  await supabase.storage.from("documents").remove([doc.storage_path]);

  return new NextResponse(null, { status: 204 });
});
