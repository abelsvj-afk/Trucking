// GET added in UI/UX Phase 3 (§2.3): the document viewer page
// (/more/documents/[id]) needs one document by id, with the same
// signed-URL serving the list uses. No PATCH here.
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

const SIGNED_URL_TTL_SECONDS = 5 * 60;

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", ctx.params.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw notFound();
  const doc = data as { storage_path: string; scan_storage_path: string | null };
  const { data: signed } = await supabase.storage
    .from("documents")
    .createSignedUrl(doc.storage_path, SIGNED_URL_TTL_SECONDS);
  let scanSignedUrl: string | null = null;
  if (doc.scan_storage_path) {
    const { data: scanSigned } = await supabase.storage
      .from("documents")
      .createSignedUrl(doc.scan_storage_path, SIGNED_URL_TTL_SECONDS);
    scanSignedUrl = scanSigned?.signedUrl ?? null;
  }
  return NextResponse.json({
    ...data,
    signed_url: signed?.signedUrl ?? null,
    scan_signed_url: scanSignedUrl,
  });
});

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
