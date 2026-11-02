// Retry the removal behind one cleanup incident (Reliability Unit A /
// F-038 surface, design A.7). Presence is checked FIRST, because the
// two successful endings are different facts and the record should say
// which one happened:
//   object present -> remove it -> incident 'resolved'
//   object absent  -> nothing to remove -> incident 'object_absent'
// A failed removal leaves the incident open with the failure appended
// to its detail - never a silent success, never a lost obligation.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import type { CleanupIncident } from "@/types/entities";

export const POST = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();

  const { data: incident, error: fetchError } = await supabase
    .from("cleanup_incidents")
    .select("*")
    .eq("id", ctx.params.id)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!incident) throw notFound();

  const row = incident as CleanupIncident;
  if (row.status !== "open") {
    return NextResponse.json(row);
  }

  const storagePath = row.storage_path;
  const slash = storagePath.lastIndexOf("/");
  const folder = slash >= 0 ? storagePath.slice(0, slash) : "";
  const fileName = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;

  const { data: listed, error: listError } = await supabase.storage
    .from("documents")
    .list(folder, { search: fileName });
  if (listError) throw new Error(listError.message);

  const present = (listed ?? []).some((obj) => obj.name === fileName);

  if (!present) {
    const { data: updated, error: updateError } = await supabase
      .from("cleanup_incidents")
      .update({ status: "object_absent", resolved_at: new Date().toISOString() })
      .eq("id", row.id)
      .select("*")
      .single();
    if (updateError) throw new Error(updateError.message);
    return NextResponse.json(updated);
  }

  const { error: removeError } = await supabase.storage
    .from("documents")
    .remove([storagePath]);

  if (removeError) {
    const { data: updated, error: updateError } = await supabase
      .from("cleanup_incidents")
      .update({
        detail: `${row.detail ?? ""} Retry on ${new Date().toISOString()} failed: ${removeError.message}`.trim(),
      })
      .eq("id", row.id)
      .select("*")
      .single();
    if (updateError) throw new Error(updateError.message);
    return NextResponse.json(updated);
  }

  const { data: resolved, error: resolveError } = await supabase
    .from("cleanup_incidents")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", row.id)
    .select("*")
    .single();
  if (resolveError) throw new Error(resolveError.message);
  return NextResponse.json(resolved);
});
