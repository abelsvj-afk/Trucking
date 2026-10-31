"use client";

// Document preview with the Original | Scan rendition toggle
// (docs/design/driver-mvp.md §8). The original photo is always the
// record; the scan is the enhanced black-and-white rendition made at
// upload. Extracted text - what the assistant reads - is one tap away
// so the owner can see exactly what the AI sees.

import { useState } from "react";
import type { DocumentWithSignedUrl } from "@/types/entities";

const IMAGE_FILE_PATTERN = /\.(jpe?g|png|webp|heic|heif)$/i;

const DOC_TYPE_LABELS: Record<string, string> = {
  bol: "Bill of lading",
  rate_confirmation: "Rate confirmation",
  scale_ticket: "Scale ticket",
  fuel_receipt: "Fuel receipt",
  settlement: "Settlement",
  other: "Document",
};

export function extractionStatusText(doc: DocumentWithSignedUrl): string {
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

export function DocumentPreview({ doc }: { doc: DocumentWithSignedUrl }) {
  const [rendition, setRendition] = useState<"original" | "scan">("original");
  const isImage = IMAGE_FILE_PATTERN.test(doc.file_name);
  const shownUrl = rendition === "scan" ? doc.scan_signed_url : doc.signed_url;

  return (
    <section aria-label={`Preview of ${doc.file_name}`}>
      <h2>{doc.file_name}</h2>
      {doc.doc_type && <p>{DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type}</p>}
      <p>{extractionStatusText(doc)}</p>

      {isImage && shownUrl && (
        <div>
          <div role="group" aria-label="Which version to view">
            <button
              type="button"
              aria-pressed={rendition === "original"}
              onClick={() => setRendition("original")}
            >
              Original
            </button>
            <button
              type="button"
              aria-pressed={rendition === "scan"}
              disabled={!doc.scan_signed_url}
              onClick={() => setRendition("scan")}
            >
              Scan
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, not a Next-optimizable asset */}
          <img
            src={shownUrl}
            alt={rendition === "scan" ? `Scanned version of ${doc.file_name}` : doc.file_name}
            style={{ maxWidth: "100%" }}
          />
        </div>
      )}

      {doc.signed_url && (
        <p>
          <a href={doc.signed_url} target="_blank" rel="noreferrer">
            Open the original file
          </a>
        </p>
      )}

      {doc.extracted_text && (
        <details>
          <summary>What the assistant reads (extracted text)</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{doc.extracted_text}</pre>
        </details>
      )}
    </section>
  );
}
