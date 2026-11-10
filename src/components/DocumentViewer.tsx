"use client";

// The document viewer (UI/UX Phase 3, spec §2.3 + mockup): dark chrome,
// white paper page, rendition toggle, "What Abel reads" section, and
// bottom actions. Faces ride the EXISTING signed-URL serving path
// (signed_url / scan_signed_url from the documents API) — no new
// byte route. Print: see handlePrint + the @media print rules in
// 03-components.css.

import { useState } from "react";
import Link from "next/link";
import type { DocumentWithSignedUrl } from "@/types/entities";
import SegmentedStatus from "@/components/SegmentedStatus";
import DocumentPageFace from "@/components/DocumentPageFace";
import { DOC_TYPE_LABELS, SITUATION_LABELS, abelReadsState, abelReadsText } from "@/lib/document-labels";
import { availableRenditions, backTarget, isPdfDocument, pageFaceKind, type Rendition } from "@/lib/document-page";
import { formatDate } from "@/lib/time";

export default function DocumentViewer({ doc }: { doc: DocumentWithSignedUrl }) {
  const renditions = availableRenditions(doc);
  const [rendition, setRendition] = useState<Rendition>("page");
  const [shareNote, setShareNote] = useState<string | null>(null);
  const face = pageFaceKind(doc);
  const kindLabel = doc.doc_type ? (DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type) : "Document";
  const back = backTarget(doc);
  const readsText = abelReadsText(doc);
  const readsState = abelReadsState(doc);
  const isPdf = isPdfDocument(doc);

  async function handleShare() {
    const url = typeof window !== "undefined" ? window.location.href : "";
    // The app's existing pattern is clipboard copy (dispatch page);
    // navigator.share is used when present, clipboard is the fallback.
    try {
      if (typeof navigator !== "undefined" && "share" in navigator) {
        await navigator.share({ title: doc.file_name, url });
        setShareNote("Shared.");
        return;
      }
      throw new Error("no share");
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        setShareNote("Link copied.");
      } catch {
        setShareNote("Couldn't share or copy the link.");
      }
    }
  }

  function handlePrint() {
    // PDF face: print routes to the PDF itself (open it; its own
    // viewer prints the file). Every other face prints via the
    // print stylesheet, which emits only .doc-print-area.
    if ((rendition === "page" && face === "pdf") || rendition === "original" && isPdf) {
      if (doc.signed_url) window.open(doc.signed_url, "_blank", "noreferrer");
      return;
    }
    window.print();
  }

  const shownImageUrl = rendition === "scan" ? doc.scan_signed_url : doc.signed_url;

  return (
    <div className="doc-viewer">
      <div className="doc-chrome">
        <Link className="doc-back" href={back.href}>‹ {back.label}</Link>
        <div className="doc-chrome-title">
          <b>{kindLabel}</b>
          <span>
            {doc.file_name} · filed against {doc.related_entity_type} · {formatDate(doc.uploaded_at, "America/New_York")}
            {doc.situation ? ` · ${SITUATION_LABELS[doc.situation] ?? doc.situation}` : ""}
            {doc.source === "generated" ? " · Created in the app" : ""}
          </span>
        </div>
        <button type="button" className="doc-share" onClick={() => void handleShare()}>Share</button>
      </div>
      {shareNote && <p role="status">{shareNote}</p>}

      {renditions.length > 1 && (
        <SegmentedStatus
          ariaLabel="Rendition"
          options={renditions}
          value={rendition}
          onChange={setRendition}
        />
      )}

      <div className="doc-print-area">
        {rendition === "page" && face === "model" && doc.model && (
          <DocumentPageFace model={doc.model} kindLabel={kindLabel} />
        )}
        {rendition === "page" && face === "pdf" && (
          <div className="doc-pdf-face">
            {doc.model === null && doc.source === "generated" && (
              <p className="doc-fallback-note">Created before document pages — showing the PDF</p>
            )}
            {doc.signed_url ? (
              <iframe title={doc.file_name} src={doc.signed_url} className="doc-pdf-frame" />
            ) : (
              <p>Couldn&apos;t load the file for this document.</p>
            )}
          </div>
        )}
        {rendition === "page" && face === "image" && doc.signed_url && (
          // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL
          <img src={doc.signed_url} alt={doc.file_name} className="doc-photo" />
        )}
        {rendition === "page" && face === "none" && (
          <p>This document&apos;s file can&apos;t be shown on a page — use Open original file below.</p>
        )}
        {(rendition === "original" || rendition === "scan") && (
          isPdf ? (
            <div className="doc-pdf-face">
              {doc.signed_url ? (
                <iframe title={doc.file_name} src={doc.signed_url} className="doc-pdf-frame" />
              ) : <p>Couldn&apos;t load the file for this document.</p>}
            </div>
          ) : shownImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL
            <img
              src={shownImageUrl}
              alt={rendition === "scan" ? `Scanned version of ${doc.file_name}` : doc.file_name}
              className="doc-photo"
            />
          ) : <p>That rendition isn&apos;t available for this document.</p>
        )}
      </div>

      <section className="doc-reads" aria-label="What Abel reads from this page">
        <h2>What Abel reads from this page</h2>
        <p>
          <span className={readsState.ok ? "doc-reads-ok" : undefined}>{readsState.label}</span>
          {" "}— one document, its faces rendered from the same record.
        </p>
        {readsText && <pre className="doc-reads-text">{readsText}</pre>}
        {!readsText && <p>{readsState.label}</p>}
      </section>

      <div className="doc-actions">
        {doc.signed_url && (
          <a className="doc-action-open" href={doc.signed_url} target="_blank" rel="noreferrer">Open original file</a>
        )}
        {isPdf && doc.signed_url && (
          <a className="doc-action-pdf" href={doc.signed_url} download={doc.file_name}>Download PDF</a>
        )}
        <button type="button" className="doc-action-print" onClick={handlePrint}>Print</button>
      </div>
    </div>
  );
}
