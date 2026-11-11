"use client";

// Documents for one trip (owner request 2026-11-05): everything filed against
// this load - the BOL, seal photos, rate con, receipts - as thumbnails grouped
// by what each is, tap to view, and a way to add one from the camera or the
// phone. Built on the existing documents pipeline (storage, signed URLs,
// scan + extraction, the Telegram photo flow that files BOLs against a load);
// no new storage and no new endpoints.

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { useLiveVersion } from "@/lib/use-live";
import { DOC_TYPE_LABELS } from "@/lib/document-labels";
import type { DocumentWithSignedUrl } from "@/types/entities";

const IMAGE = /\.(jpe?g|png|webp|heic|heif)$/i;
const PURPOSE_LABELS: Record<string, string> = {
  paperwork: "Paperwork",
  trailer: "Trailer photos",
  truck_exterior: "Truck photos",
  odometer_dash: "Dash / odometer",
};

/** What a document is, in his words: the read document type, else the photo's purpose, else "Other". */
export function groupLabel(doc: Pick<DocumentWithSignedUrl, "doc_type" | "photo_purpose">): string {
  if (doc.doc_type && doc.doc_type !== "other") return DOC_TYPE_LABELS[doc.doc_type] ?? "Other";
  if (doc.photo_purpose && PURPOSE_LABELS[doc.photo_purpose]) return PURPOSE_LABELS[doc.photo_purpose]!;
  return "Other";
}

export function groupDocuments(docs: DocumentWithSignedUrl[]): Array<{ label: string; docs: DocumentWithSignedUrl[] }> {
  const groups = new Map<string, DocumentWithSignedUrl[]>();
  for (const doc of docs) {
    if (doc.deleted_at) continue;
    const label = groupLabel(doc);
    groups.set(label, [...(groups.get(label) ?? []), doc]);
  }
  return [...groups.entries()]
    .map(([label, list]) => ({ label, docs: [...list].sort((a, b) => b.created_at.localeCompare(a.created_at)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export default function LoadDocuments({ loadId }: { loadId: string }) {
  const version = useLiveVersion(["documents"]);
  const [docs, setDocs] = useState<DocumentWithSignedUrl[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiClient
      .listDocuments<DocumentWithSignedUrl>("load", loadId)
      .then((res) => {
        setDocs(res.data);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [loadId]);

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
      await apiClient.uploadDocument({ file, related_entity_type: "load", related_entity_id: loadId });
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't upload that. Try again.");
    } finally {
      setUploading(false);
    }
  }

  const groups = docs ? groupDocuments(docs) : [];

  return (
    <section aria-label="Trip documents">
      <h2>Documents for this trip</h2>
      {failed && <p role="alert">Couldn&apos;t load the documents. <button type="button" onClick={load}>Try again</button></p>}
      {docs && groups.length === 0 && <p className="row-sub">Nothing filed against this trip yet — add the BOL, seal photo and paperwork here, or send them to Abel.</p>}
      {groups.map((group) => (
        <div key={group.label}>
          <h3>{group.label}</h3>
          <ul className="doc-thumbs" style={{ display: "flex", flexWrap: "wrap", gap: "8px", listStyle: "none", padding: 0 }}>
            {group.docs.map((doc) => (
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
        </div>
      ))}
      {/* A <form> on purpose: the app-wide driving lock makes forms inert while moving. */}
      <form aria-label="Add a document to this trip" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor={`load-doc-${loadId}`}>Add a photo or file to this trip</label>
        <input
          id={`load-doc-${loadId}`}
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
