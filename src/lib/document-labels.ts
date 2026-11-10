// Document labels + extraction wording — moved out of the retired
// DocumentPreview component (UI/UX Phase 3, spec §2.3) into a shared
// lib module so the document viewer page, the Documents landing, and
// the entity document lists all read the same words.

import type { DocumentWithSignedUrl } from "@/types/entities";
import { documentModelToText, type DocumentModel } from "@/lib/document-templates";

export const DOC_TYPE_LABELS: Record<string, string> = {
  bol: "Bill of lading",
  rate_confirmation: "Rate confirmation",
  scale_ticket: "Scale ticket",
  fuel_receipt: "Fuel receipt",
  settlement: "Settlement",
  receipt: "Receipt",
  agreement: "Agreement",
  invoice: "Invoice",
  statement: "Statement",
  other: "Document",
};

/** The bookkeeping situation a document belongs to (00085), in his words. */
export const SITUATION_LABELS: Record<string, string> = {
  carrier: "Working for a carrier",
  own_authority: "Own authority",
  business_records: "Business records",
};

export function extractionStatusText(doc: Pick<DocumentWithSignedUrl, "extraction_status" | "extraction_error" | "model" | "source">): string {
  // A generated document's text comes from its stored model — it is
  // never in an empty extraction state.
  if (doc.model) return "Text from the document itself — the assistant reads the same words shown on this page.";
  switch (doc.extraction_status) {
    case "done":
      return "Text extracted — the assistant can answer questions about this document.";
    case "failed":
      return doc.extraction_error ?? "Text extraction didn't work for this one.";
    case "disabled":
      return "Text extraction is off. Turn on “Document text extraction” in Settings to make this readable by the assistant.";
    case "not_applicable":
      return "Text extraction isn't run on PDFs.";
    default:
      return "Text not extracted yet.";
  }
}

/** The text Abel reads for this document: model text wins, then extracted text. */
export function abelReadsText(doc: Pick<DocumentWithSignedUrl, "model" | "extracted_text">): string | null {
  if (doc.model) {
    const model = doc.model as DocumentModel;
    if (model && typeof model.title === "string" && Array.isArray(model.sections)) {
      return documentModelToText(model).join("\n");
    }
  }
  return doc.extracted_text ?? null;
}

export function abelReadsState(doc: Pick<DocumentWithSignedUrl, "model" | "extracted_text" | "extraction_status" | "extraction_error" | "source">): { ok: boolean; label: string } {
  if (doc.model) return { ok: true, label: "Text from the document model ✓" };
  if (doc.extracted_text) return { ok: true, label: "Text extracted ✓" };
  return { ok: false, label: extractionStatusText(doc) };
}
