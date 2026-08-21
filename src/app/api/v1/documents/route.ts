// Documents don't fit the generic createCrudRoutes shape (docs/api-contracts.md):
// multipart/form-data upload instead of JSON, no PATCH, and the list
// response carries a short-lived signed URL per row instead of the raw
// storage path. So this is hand-written against the same createApiHandler
// pipeline every other route uses, not the shared factory.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { relatedEntityTypeSchema } from "@/data/schemas/documents";
import type { DocumentWithSignedUrl } from "@/types/entities";

const relatedEntityIdSchema = z.string().uuid();

// Generous enough for scanned paperwork (BOLs, receipts, permits) without
// being unbounded - docs/schemas.md doesn't set a limit, so this is a
// reasonable default rather than trusting an arbitrarily large upload.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 5 * 60;

export const POST = createApiHandler(async (req, ctx) => {
  const formData = await req.formData();
  const file = formData.get("file");
  const relatedEntityTypeRaw = formData.get("related_entity_type");
  const relatedEntityIdRaw = formData.get("related_entity_id");
  const fileNameRaw = formData.get("file_name");

  if (!(file instanceof File)) throw validationError("file is required.");
  if (file.size === 0) throw validationError("file must not be empty.");
  if (file.size > MAX_FILE_BYTES) throw validationError("file exceeds the 25MB limit.");

  const typeResult = relatedEntityTypeSchema.safeParse(relatedEntityTypeRaw);
  if (!typeResult.success) {
    throw validationError("related_entity_type must be one of truck, trailer, driver, load.");
  }

  const idResult =
    typeof relatedEntityIdRaw === "string"
      ? relatedEntityIdSchema.safeParse(relatedEntityIdRaw)
      : null;
  if (!idResult?.success) throw validationError("related_entity_id must be a valid id.");

  const fileName = typeof fileNameRaw === "string" && fileNameRaw.trim() ? fileNameRaw.trim() : file.name;
  if (!fileName) throw validationError("file_name is required.");

  const supabase = await createClient();
  const storagePath = `${ctx.auth.companyId}/${crypto.randomUUID()}-${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, file, { contentType: file.type || undefined });
  if (uploadError) throw validationError(`Upload failed: ${uploadError.message}`);

  const { data: row, error: insertError } = await supabase
    .from("documents")
    .insert({
      company_id: ctx.auth.companyId,
      related_entity_type: typeResult.data,
      related_entity_id: idResult.data,
      file_name: fileName,
      storage_path: storagePath,
      uploaded_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError || !row) {
    // Don't leave an orphaned file in Storage when the DB write fails.
    await supabase.storage.from("documents").remove([storagePath]);
    throw new Error(insertError?.message ?? "Failed to save document metadata.");
  }

  return NextResponse.json(row, { status: 201 });
});

export const GET = createApiHandler(async (req) => {
  const supabase = await createClient();
  const url = new URL(req.url);
  const relatedEntityType = url.searchParams.get("related_entity_type");
  const relatedEntityId = url.searchParams.get("related_entity_id");

  if (!relatedEntityType || !relatedEntityId) {
    throw validationError("related_entity_type and related_entity_id are required.");
  }

  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("related_entity_type", relatedEntityType)
    .eq("related_entity_id", relatedEntityId)
    .order("uploaded_at", { ascending: false });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as DocumentWithSignedUrl[];
  const withUrls = await Promise.all(
    rows.map(async (doc) => {
      const { data: signed, error: signError } = await supabase.storage
        .from("documents")
        .createSignedUrl(doc.storage_path, SIGNED_URL_TTL_SECONDS);
      return { ...doc, signed_url: signError ? null : (signed?.signedUrl ?? null) };
    }),
  );

  return NextResponse.json({ data: withUrls });
});
