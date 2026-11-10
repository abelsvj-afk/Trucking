// Shared document storage pipeline (design §13). ONE path for putting
// a file into the app's documents: the web upload route
// (POST /api/v1/documents) and the Telegram photo intake both store
// through here, so a file that arrives by either door lands in the
// same private "documents" bucket, under the same
// {company_id}/{uuid}-{file_name} path convention the Storage RLS
// policies check (migration 00007), with the same documents row
// shape - and the same cleanup rule: if the row insert fails, the
// uploaded file is removed again, so Storage never keeps an orphan
// no row points at.
//
// The caller owns validation of the entity fields that are specific
// to its surface (the web route Zod-checks related_entity_type
// against the picklist enum; the Telegram intake files under the
// company itself - see photo-intake.ts). This helper enforces the
// surface-independent rules both doors share: non-empty, the 25MB
// cap, and the paperwork content-type allowlist (the task 5.3
// security-review rule from the route, unchanged).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Document } from "@/types/entities";
import { recordCleanupIncident } from "./cleanup-incidents";

// Generous enough for scanned paperwork (BOLs, receipts, permits)
// without being unbounded - the same limit the web route has always
// enforced (docs/schemas.md sets none, so this stays the default).
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

// A real gap found and fixed in the task 5.3 security review:
// content-type validation against an allowlist matching this
// document store's actual use case (scans/photos of paperwork),
// checked against the declared content-type - not byte-level
// signature sniffing, the deliberate simplicity tradeoff documented
// in docs/design/security.md.
export const ALLOWED_DOCUMENT_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export type StoreDocumentErrorKind = "validation" | "upload_failed" | "insert_failed";

export class StoreDocumentError extends Error {
  kind: StoreDocumentErrorKind;

  constructor(kind: StoreDocumentErrorKind, message: string) {
    super(message);
    this.name = "StoreDocumentError";
    this.kind = kind;
  }
}

export interface StoreDocumentInput {
  companyId: string;
  relatedEntityType: string;
  relatedEntityId: string;
  fileName: string;
  /** The file body. The web route passes its multipart File; the Telegram intake passes a Blob built from the downloaded bytes. */
  body: Blob;
  contentType: string;
  size: number;
  /**
   * Lane 1 (audit B-6): the sender's note on the file (a Telegram
   * photo caption), stored ON the document row (migration 00033)
   * and folded into the document search vector - a caption that
   * lives only in a chat timeline stops being findable once the
   * conversation scrolls past it. Optional; before 00033 lands the
   * insert retries without it (graceful absence, below).
   */
  caption?: string;
  /**
   * Document creation spec (migration 00085): the paperwork kind, the
   * bookkeeping situation, and generated-document provenance. All
   * optional; before 00085 lands the insert retries without them
   * (graceful absence, same pattern as caption).
   */
  docType?: string;
  situation?: string | null;
  source?: "upload" | "generated";
  generator?: string | null;
  /** Stored DocumentModel (migration 00088): only generated documents carry one. Graceful absence like the 00085 fields. */
  model?: import("@/lib/document-templates").DocumentModel | null;
}

/**
 * Uploads the file to the documents bucket and inserts its row.
 * Throws StoreDocumentError: "validation" for the caller's own bad
 * input (empty/oversize/disallowed type), "upload_failed" /
 * "insert_failed" for provider failures (message detail is for
 * server logs - surfaces translate it before showing the owner).
 */
export async function storeDocumentFile(
  client: SupabaseClient,
  input: StoreDocumentInput,
): Promise<Document> {
  if (input.size === 0) {
    throw new StoreDocumentError("validation", "file must not be empty.");
  }
  if (input.size > MAX_DOCUMENT_BYTES) {
    throw new StoreDocumentError("validation", "file exceeds the 25MB limit.");
  }
  if (!ALLOWED_DOCUMENT_CONTENT_TYPES.has(input.contentType)) {
    throw new StoreDocumentError(
      "validation",
      "file must be a PDF or an image (JPEG, PNG, WebP, HEIC).",
    );
  }

  const storagePath = `${input.companyId}/${crypto.randomUUID()}-${input.fileName}`;

  const { error: uploadError } = await client.storage
    .from("documents")
    .upload(storagePath, input.body, { contentType: input.contentType || undefined });
  if (uploadError) {
    throw new StoreDocumentError(
      "upload_failed",
      `Document upload to Storage failed: ${uploadError.message}`,
    );
  }

  const baseRow = {
    company_id: input.companyId,
    related_entity_type: input.relatedEntityType,
    related_entity_id: input.relatedEntityId,
    file_name: input.fileName,
    storage_path: storagePath,
    uploaded_at: new Date().toISOString(),
  };
  // The caption column arrives with migration 00033; the client's
  // generated row type predates it, so the payload is widened
  // explicitly here (the runtime fallback below covers databases
  // where the column doesn't exist yet).
  const extras: Record<string, unknown> = {};
  if (input.caption) extras.caption = input.caption;
  if (input.docType) extras.doc_type = input.docType;
  if (input.situation !== undefined) extras.situation = input.situation;
  if (input.source) extras.source = input.source;
  if (input.generator !== undefined) extras.generator = input.generator;
  if (input.model !== undefined && input.model !== null) extras.model = input.model;
  const insertRow = { ...baseRow, ...extras };
  let insertResult = await client
    .from("documents")
    .insert(insertRow as typeof baseRow)
    .select()
    .single();
  if (
    insertResult.error &&
    Object.keys(extras).length > 0 &&
    /caption|doc_type|situation|source|generator|model/.test(insertResult.error.message) &&
    /does not exist|could not find/i.test(insertResult.error.message)
  ) {
    // Graceful absence: a metadata column (00033 caption / 00085
    // doc_type-situation-source-generator) is not applied yet - store
    // the document without the new metadata rather than losing the
    // file over it.
    insertResult = await client.from("documents").insert(baseRow).select().single();
  }
  const { data: row, error: insertError } = insertResult;

  if (insertError || !row) {
    // Don't leave an orphaned file in Storage when the DB write fails -
    // and CHECK that the removal actually happened (Unit A / F-038).
    // The old code fired remove() and never looked at the result, so a
    // failed cleanup was indistinguishable from a successful one. On
    // failure the obligation is recorded as a cleanup incident for the
    // Documents page's retry surface, and the error says plainly that
    // cleanup may have failed.
    const { data: removed, error: removeError } = await client.storage
      .from("documents")
      .remove([storagePath]);
    const cleanupFailed = removeError !== null || !removed || removed.length === 0;
    if (cleanupFailed) {
      await recordCleanupIncident(client, {
        companyId: input.companyId,
        storagePath,
        // Kind name per design A.7/A.8.6b: this is the upload-rollback
        // case - the upload happened, its row insert failed, and the
        // rollback removal could not confirm the object is gone.
        kind: "upload_rollback",
        detail: `Row insert failed (${insertError?.message ?? "no row returned"}) and the compensating storage removal did not confirm the object is gone.`,
      });
      throw new StoreDocumentError(
        "insert_failed",
        `${insertError?.message ?? "Failed to save document metadata."} The uploaded file could not be cleaned up automatically - it has been recorded for manual cleanup.`,
      );
    }
    throw new StoreDocumentError(
      "insert_failed",
      insertError?.message ?? "Failed to save document metadata.",
    );
  }

  return row as Document;
}
