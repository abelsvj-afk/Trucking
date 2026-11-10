"use client";

// Documents filed against one record (expense buckets + documents
// spec 2026-11-09): the expense detail page's Documents section -
// thumbnails in place, tap to preview in place / full screen, upload
// in place. Same documents pipeline as the load page's section
// (LoadDocuments): storage, signed URLs, scan + extraction; the
// upload carries the paperwork kind + situation pickers so a document
// is typed by the bookkeeping situation it belongs to.

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { useLiveVersion } from "@/lib/use-live";
import type { DocumentWithSignedUrl } from "@/types/entities";

const IMAGE = /\.(jpe?g|png|webp|heic|heif)$/i;

const DOC_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Kind not set" },
  { value: "receipt", label: "Receipt" },
  { value: "agreement", label: "Agreement" },
  { value: "invoice", label: "Invoice" },
  { value: "statement", label: "Statement" },
  { value: "settlement", label: "Settlement" },
  { value: "bol", label: "Bill of lading" },
  { value: "rate_confirmation", label: "Rate confirmation" },
  { value: "scale_ticket", label: "Scale ticket" },
  { value: "fuel_receipt", label: "Fuel receipt" },
  { value: "other", label: "Other" },
];

const SITUATION_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Situation not set" },
  { value: "carrier", label: "Working for a carrier" },
  { value: "own_authority", label: "Own authority" },
  { value: "business_records", label: "Business records" },
];

export default function EntityDocuments({
  entityType,
  entityId,
  heading = "Documents for this record",
}: {
  entityType: string;
  entityId: string;
  heading?: string;
}) {
  const version = useLiveVersion(["documents"]);
  const [docs, setDocs] = useState<DocumentWithSignedUrl[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docType, setDocType] = useState("");
  const [situation, setSituation] = useState("");

  const load = useCallback(() => {
    apiClient
      .listDocuments<DocumentWithSignedUrl>(entityType, entityId)
      .then((res) => {
        setDocs(res.data);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [entityType, entityId]);

  useEffect(() => {
    load();
  }, [load, version]);

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await apiClient.uploadDocument({
        file,
        related_entity_type: entityType,
        related_entity_id: entityId,
        doc_type: docType || undefined,
        situation: situation || undefined,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't upload that. Try again.");
    } finally {
      setUploading(false);
    }
  }

  const visible = (docs ?? []).filter((d) => !d.deleted_at);

  return (
    <section aria-label={heading}>
      <h2>{heading}</h2>
      {failed && (
        <p role="alert">
          Couldn&apos;t load the documents.{" "}
          <button type="button" onClick={load}>
            Try again
          </button>
        </p>
      )}
      {docs && visible.length === 0 && (
        <p className="row-sub">
          Nothing filed against this record yet — add the receipt or paperwork here, or ask Abel to create the
          document for it.
        </p>
      )}
      {visible.length > 0 && (
        <ul className="doc-thumbs" style={{ display: "flex", flexWrap: "wrap", gap: "8px", listStyle: "none", padding: 0 }}>
          {visible.map((doc) => (
            <li key={doc.id}>
              <Link
                href={`/more/documents/${doc.id}`}
                aria-label={`View ${doc.file_name}`}
                style={{ display: "block", width: "88px", minHeight: "88px", overflow: "hidden" }}
              >
                {IMAGE.test(doc.file_name) && doc.signed_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, not Next-optimizable
                  <img src={doc.signed_url} alt="" style={{ width: "88px", height: "88px", objectFit: "cover" }} />
                ) : (
                  <span className="row-sub">{doc.file_name}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {/* A <form> on purpose: the app-wide driving lock makes forms inert while moving. */}
      <form aria-label="Add a document to this record" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor={`doc-kind-${entityId}`}>What kind of document is it?</label>
        <select id={`doc-kind-${entityId}`} value={docType} onChange={(e) => setDocType(e.target.value)}>
          {DOC_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label htmlFor={`doc-situation-${entityId}`}>Which books does it belong to?</label>
        <select id={`doc-situation-${entityId}`} value={situation} onChange={(e) => setSituation(e.target.value)}>
          {SITUATION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label htmlFor={`entity-doc-${entityId}`}>Add a photo or file to this record</label>
        <input
          id={`entity-doc-${entityId}`}
          type="file"
          accept="image/*,application/pdf"
          disabled={uploading}
          onChange={(e) => void onPick(e)}
        />
      </form>
      {uploading && <p role="status">Uploading…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
