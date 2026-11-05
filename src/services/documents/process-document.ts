// Post-upload document processing (docs/design/driver-mvp.md §10):
// produces the scan rendition and runs AI text extraction, writing
// both outcomes onto the documents row the upload route just created.
//
// This function NEVER throws and never blocks the upload - every
// failure degrades to state on the row (no scan path, an
// extraction_status that says what happened). The paperwork itself
// is already safely stored by the time this runs.

import type { SupabaseClient } from "@supabase/supabase-js";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import type { AiVisionProvider } from "@/services/ai/provider";
import {
  DOCUMENT_EXTRACTION_CAPABILITY,
  extractDocumentText,
} from "@/services/ai/document-extraction";
import { createScanRendition, SCANNABLE_CONTENT_TYPES } from "./scan-image";

export interface ProcessUploadedDocumentInput {
  companyId: string;
  documentId: string;
  fileBuffer: Buffer;
  contentType: string;
  fileName: string;
}

export interface ProcessDocumentDeps {
  /** Injectable for tests; defaults to the real OpenAI provider. */
  createVisionProvider?: () => AiVisionProvider;
}

/**
 * The extraction gate, shared: the processor checks it before any
 * provider call, and the Telegram photo intake (§13) checks it to
 * decide whether a stored photo enters processing at all — one
 * definition of "on" for both doors.
 */
export async function isExtractionEnabled(
  supabase: SupabaseClient,
  companyId: string,
): Promise<boolean> {
  const [companyResult, capabilityResult] = await Promise.all([
    supabase.from("companies").select("ai_globally_disabled").eq("id", companyId).single(),
    supabase
      .from("ai_capability_settings")
      .select("enabled")
      .eq("company_id", companyId)
      .eq("capability", DOCUMENT_EXTRACTION_CAPABILITY)
      .maybeSingle(),
  ]);

  if (companyResult.error) throw new Error(companyResult.error.message);
  if (capabilityResult.error) throw new Error(capabilityResult.error.message);

  const globallyDisabled =
    (companyResult.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled ?? false;
  // No row = off, fails closed - same convention as every other capability.
  const capabilityEnabled =
    (capabilityResult.data as { enabled: boolean } | null)?.enabled ?? false;
  return !globallyDisabled && capabilityEnabled;
}

export async function processUploadedDocument(
  supabase: SupabaseClient,
  input: ProcessUploadedDocumentInput,
  deps: ProcessDocumentDeps = {},
): Promise<void> {
  const updates: Record<string, unknown> = {};
  try {
    // --- Scan rendition (images only; design §10.1) ---
    let extractionImage: { buffer: Buffer; mediaType: string } = {
      buffer: input.fileBuffer,
      mediaType: input.contentType,
    };
    if (SCANNABLE_CONTENT_TYPES.has(input.contentType)) {
      const scan = await createScanRendition(input.fileBuffer, input.contentType);
      if (scan) {
        const baseName =
          input.fileName.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-") || "document";
        const scanPath = `${input.companyId}/${crypto.randomUUID()}-scan-${baseName}.png`;
        const { error: scanUploadError } = await supabase.storage
          .from("documents")
          .upload(scanPath, scan, { contentType: "image/png" });
        if (scanUploadError) {
          console.error("Document scan upload to Storage failed:", scanUploadError.message);
        } else {
          updates.scan_storage_path = scanPath;
          // The scan is the crisper read - extraction prefers it.
          extractionImage = { buffer: scan, mediaType: "image/png" };
        }
      }
    }

    // --- Text extraction (kill-switched capability; design §10.2) ---
    if (input.contentType === "application/pdf") {
      updates.extraction_status = "not_applicable";
    } else {
      let enabled: boolean | null = null;
      try {
        enabled = await isExtractionEnabled(supabase, input.companyId);
      } catch (err) {
        console.error("Document extraction settings check failed:", err);
        updates.extraction_status = "failed";
        updates.extraction_error = "Couldn't verify the AI settings for this upload.";
        updates.extracted_at = new Date().toISOString();
      }

      if (enabled === false) {
        updates.extraction_status = "disabled";
      } else if (enabled === true) {
        try {
          const provider = (deps.createVisionProvider ?? (() => new OpenAiProvider()))();
          const extraction = await extractDocumentText(provider, {
            imageBase64: extractionImage.buffer.toString("base64"),
            mediaType: extractionImage.mediaType,
          });
          updates.doc_type = extraction.doc_type;
          updates.extracted_text = extraction.text;
          updates.extracted_fields = extraction.fields;
          updates.extraction_status = "done";
          updates.extraction_error = null;
          updates.extracted_at = new Date().toISOString();
        } catch (err) {
          // The stored note is deliberately generic; the real detail
          // stays in the server log (CLAUDE.md: no raw exception text
          // in anything the client can read).
          console.error("Document extraction failed:", err);
          updates.extraction_status = "failed";
          updates.extraction_error =
            "The document couldn't be read automatically. It's saved - try a clearer, flatter photo if you need its text.";
          updates.extracted_at = new Date().toISOString();
        }
      }
    }
  } catch (err) {
    console.error("Document post-processing failed:", err);
  }

  if (Object.keys(updates).length === 0) return;
  try {
    // Doc-intake hunt DH-1: extracted_fields is a SHARED jsonb column.
    // The Telegram album writers keep their grouping keys there
    // (media_group_id, album_pages), stamped BEFORE processing runs;
    // a wholesale replace on extraction success would erase the group
    // and silently split the album. Carry those two keys over from
    // the row's current value. Failure-isolated: a failed read falls
    // back to the plain replace rather than losing the whole write.
    // (Web uploads never carry these keys - behavior unchanged there.)
    if ("extracted_fields" in updates) {
      try {
        const { data } = await supabase
          .from("documents")
          .select("extracted_fields")
          .eq("id", input.documentId)
          .eq("company_id", input.companyId)
          .maybeSingle();
        const existing = (
          data as { extracted_fields: Record<string, unknown> | null } | null
        )?.extracted_fields;
        if (existing && ("media_group_id" in existing || "album_pages" in existing)) {
          const carried: Record<string, unknown> = {};
          if ("media_group_id" in existing) carried.media_group_id = existing.media_group_id;
          if ("album_pages" in existing) carried.album_pages = existing.album_pages;
          updates.extracted_fields = {
            ...(updates.extracted_fields as Record<string, unknown>),
            ...carried,
          };
        }
      } catch (readErr) {
        console.error("Document album-key preservation read failed:", readErr);
      }
    }
    const { error } = await supabase
      .from("documents")
      .update(updates)
      .eq("id", input.documentId);
    if (error) console.error("Failed to store document processing results:", error.message);
  } catch (err) {
    console.error("Failed to store document processing results:", err);
  }
}
