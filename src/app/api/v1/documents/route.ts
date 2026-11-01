// Documents don't fit the generic createCrudRoutes shape (docs/api-contracts.md):
// multipart/form-data upload instead of JSON, no PATCH, and the list
// response carries a short-lived signed URL per row instead of the raw
// storage path. So this is hand-written against the same createApiHandler
// pipeline every other route uses, not the shared factory.
//
// The storage write itself lives in the shared documents pipeline
// (services/documents/store-document.ts) — the same code the Telegram
// photo intake stores through (§13), so both doors enforce the same
// size cap, the same content-type allowlist (task 5.3), and the same
// no-orphan cleanup. This route keeps the surface-specific work:
// multipart parsing, the entity picklist validation, mapping the
// pipeline's typed errors onto this API's error shape (validation
// kinds are the caller's 400s; provider failures stay generic Errors
// so createApiHandler never surfaces raw provider detail) — and the
// post-store processing (§10): scan rendition + AI extraction via
// processUploadedDocument, the same entry point the Telegram intake
// invokes for its stored photos (§13).

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { relatedEntityTypeSchema } from "@/data/schemas/documents";
import {
  StoreDocumentError,
  storeDocumentFile,
} from "@/services/documents/store-document";
import { processUploadedDocument } from "@/services/documents/process-document";
import type { Document, DocumentWithSignedUrl } from "@/types/entities";

const relatedEntityIdSchema = z.string().uuid();

const SIGNED_URL_TTL_SECONDS = 5 * 60;

export const POST = createApiHandler(async (req, ctx) => {
  const formData = await req.formData();
  const file = formData.get("file");
  const relatedEntityTypeRaw = formData.get("related_entity_type");
  const relatedEntityIdRaw = formData.get("related_entity_id");
  const fileNameRaw = formData.get("file_name");

  if (!(file instanceof File)) throw validationError("file is required.");

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
  let row: Document;
  try {
    row = await storeDocumentFile(supabase, {
      companyId: ctx.auth.companyId,
      relatedEntityType: typeResult.data,
      relatedEntityId: idResult.data,
      fileName,
      body: file,
      contentType: file.type,
      size: file.size,
    });
  } catch (err) {
    if (err instanceof StoreDocumentError) {
      // Validation kinds are this caller's 400s, with the pipeline's
      // own message (identical to the checks this route used to run
      // inline). Provider failures keep the old treatment: a plain
      // Error, so the handler's generic response is all the client
      // sees and the detail stays in the server log.
      if (err.kind === "validation") throw validationError(err.message);
      throw new Error(err.message);
    }
    throw err;
  }

  // Scan rendition + AI extraction (docs/design/driver-mvp.md §10).
  // processUploadedDocument never throws - its outcomes are state on
  // the row - so the upload's 201 doesn't depend on either succeeding.
  // The row is re-read so the response carries that state.
  await processUploadedDocument(supabase, {
    companyId: ctx.auth.companyId,
    documentId: row.id as string,
    fileBuffer: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
    fileName,
  });

  const { data: finalRow } = await supabase
    .from("documents")
    .select("*")
    .eq("id", row.id as string)
    .single();

  return NextResponse.json(finalRow ?? row, { status: 201 });
});

export const GET = createApiHandler(async (req) => {
  const supabase = await createClient();
  const url = new URL(req.url);
  const relatedEntityType = url.searchParams.get("related_entity_type");
  const relatedEntityId = url.searchParams.get("related_entity_id");
  const query = url.searchParams.get("q")?.trim();

  // Search mode (docs/api-contracts.md): q alone is enough - it
  // searches every document's extracted text. Without q, the entity
  // filter stays required together, exactly as the contract has
  // always said.
  if (!query && (!relatedEntityType || !relatedEntityId)) {
    throw validationError("related_entity_type and related_entity_id are required.");
  }

  let builder = supabase.from("documents").select("*");
  if (relatedEntityType) builder = builder.eq("related_entity_type", relatedEntityType);
  if (relatedEntityId) builder = builder.eq("related_entity_id", relatedEntityId);
  if (query) {
    builder = builder.textSearch("extracted_tsv", query, { type: "websearch" });
  }
  const { data, error } = await builder.order("uploaded_at", { ascending: false });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as DocumentWithSignedUrl[];
  const withUrls = await Promise.all(
    rows.map(async (doc) => {
      const { data: signed, error: signError } = await supabase.storage
        .from("documents")
        .createSignedUrl(doc.storage_path, SIGNED_URL_TTL_SECONDS);
      let scanSignedUrl: string | null = null;
      if (doc.scan_storage_path) {
        const { data: scanSigned, error: scanSignError } = await supabase.storage
          .from("documents")
          .createSignedUrl(doc.scan_storage_path, SIGNED_URL_TTL_SECONDS);
        scanSignedUrl = scanSignError ? null : (scanSigned?.signedUrl ?? null);
      }
      return {
        ...doc,
        signed_url: signError ? null : (signed?.signedUrl ?? null),
        scan_signed_url: scanSignedUrl,
      };
    }),
  );

  return NextResponse.json({ data: withUrls });
});
