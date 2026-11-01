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

  const { data: row, error: insertError } = await client
    .from("documents")
    .insert({
      company_id: input.companyId,
      related_entity_type: input.relatedEntityType,
      related_entity_id: input.relatedEntityId,
      file_name: input.fileName,
      storage_path: storagePath,
      uploaded_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError || !row) {
    // Don't leave an orphaned file in Storage when the DB write fails.
    await client.storage.from("documents").remove([storagePath]);
    throw new StoreDocumentError(
      "insert_failed",
      insertError?.message ?? "Failed to save document metadata.",
    );
  }

  return row as Document;
}
