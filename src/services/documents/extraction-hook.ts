// Document text extraction — the status reader for Telegram-stored
// photos (design §13). Document scan + extraction (scan rendition,
// verbatim extracted_text, doc_type, key fields) lives in
// services/documents/process-document.ts (§10); this module is only
// the read side of the contract (docs/api-contracts.md, §9's
// graceful-absence rule):
//
// - The capability is `document_extraction` in
//   ai_capability_settings, OFF unless a row enables it — the same
//   fail-closed convention as every other capability.
// - A processed document carries doc_type / extracted_text /
//   extraction_status on its documents row (migration 00022,
//   already applied to the live database).
//
// So this reader works before and after that merge with no change:
// capability off (or no row) → "off"; capability on but the columns
// aren't in the database yet → "unavailable" (honest: nothing could
// have read the document); columns present → the document's real
// state (done with its type + text opening, failed, or still
// pending). The merge-time wiring LANDED with the intake merge prep
// (§13): photo-intake invokes document-scan's processor for
// Telegram-stored rows whenever the extraction gate is open, so a
// Telegram photo's state here is its real processing outcome — the
// same as a web upload's, never dressed up as read before it is.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "@/services/bot/tool-helpers";

export const DOCUMENT_EXTRACTION_CAPABILITY = "document_extraction";

export type DocumentExtractionStatus =
  | { state: "off" }
  | { state: "unavailable" }
  | { state: "processing" }
  | { state: "failed" }
  | { state: "done"; docType: string | null; summary: string };

const SUMMARY_CHARS = 300;

export async function getDocumentExtractionStatus(
  client: SupabaseClient,
  companyId: string,
  documentId: string,
): Promise<DocumentExtractionStatus> {
  const { data: setting, error: settingError } = await client
    .from("ai_capability_settings")
    .select("enabled")
    .eq("company_id", companyId)
    .eq("capability", DOCUMENT_EXTRACTION_CAPABILITY)
    .maybeSingle();
  if (settingError) throw new Error(settingError.message);
  // No row = off, fails closed — same convention as every capability.
  if (!(setting as { enabled: boolean } | null)?.enabled) return { state: "off" };

  const { data: doc, error: docError } = await client
    .from("documents")
    .select("doc_type, extracted_text, extraction_status")
    .eq("id", documentId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (docError) {
    // Graceful absence (§9): migration 00022's columns aren't in
    // this database yet, so nothing could have read the document.
    if (isMissingColumnError(docError)) return { state: "unavailable" };
    throw new Error(docError.message);
  }
  if (!doc) return { state: "unavailable" };

  const row = doc as {
    doc_type: string | null;
    extracted_text: string | null;
    extraction_status: string | null;
  };
  const text = row.extracted_text?.trim() ?? "";
  if (text) {
    return {
      state: "done",
      docType: row.doc_type,
      summary: text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text,
    };
  }
  if (row.extraction_status && /fail/i.test(row.extraction_status)) {
    return { state: "failed" };
  }
  return { state: "processing" };
}
