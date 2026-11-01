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
    .select("storage_path, scan_storage_path")
    .eq("id", ctx.params.id)
    .maybeSingle();

  if (fetchError || !doc) throw notFound();

  const { error: deleteRowError } = await supabase.from("documents").delete().eq("id", ctx.params.id);
  if (deleteRowError) throw new Error(deleteRowError.message);

  // Row is gone either way; a failure to also remove the files leaves
  // orphaned objects rather than a broken document - acceptable since
  // they're no longer reachable through the app. The scan rendition
  // (docs/design/driver-mvp.md §8) is removed with the original.
  const paths = [doc.storage_path, doc.scan_storage_path].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
  await supabase.storage.from("documents").remove(paths);

  return new NextResponse(null, { status: 204 });
});
