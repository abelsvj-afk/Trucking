"use client";

// UI/UX upgrade (migration 00027): a truck/driver/trailer photo, riding
// the existing documents pipeline end to end - the file uploads as a
// document linked to the entity, the entity's photo_document_id points
// at that document row, and display resolves the document's short-lived
// signed URL through the same listDocuments call the Documents screen
// uses. No new storage, no new endpoints, original file kept as-is.

import { useEffect, useState, type ChangeEvent } from "react";
import { apiClient } from "@/lib/api-client";
import type { Document, DocumentWithSignedUrl } from "@/types/entities";

type PhotoEntityType = "truck" | "driver" | "trailer";

interface EntityPhotoProps {
  entityType: PhotoEntityType;
  entityId: string;
  photoDocumentId: string | null;
  /** "thumb" for list rows, "hero" for detail screens. */
  size: "thumb" | "hero";
  alt: string;
}

export function EntityPhoto({ entityType, entityId, photoDocumentId, size, alt }: EntityPhotoProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!photoDocumentId) return;
    let cancelled = false;
    apiClient
      .listDocuments<DocumentWithSignedUrl>(entityType, entityId)
      .then((res) => {
        if (cancelled) return;
        const photo = res.data.find((doc) => doc.id === photoDocumentId);
        setUrl(photo?.signed_url ?? null);
      })
      .catch(() => {
        // A photo that won't load is a missing picture, not an error
        // state - the placeholder below covers it silently.
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId, photoDocumentId]);

  if (!photoDocumentId || !url) {
    return (
      <div className={`entity-photo entity-photo-${size} entity-photo-empty`} aria-hidden="true">
        <svg width="28" height="20" viewBox="0 0 28 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="1" y="5" width="15" height="8" rx="1" fill="currentColor" opacity="0.35" />
          <path d="M16 8h4.5l3 3v2H16z" fill="currentColor" opacity="0.55" />
          <circle cx="6" cy="16" r="2.2" fill="currentColor" opacity="0.7" />
          <circle cx="22" cy="16" r="2.2" fill="currentColor" opacity="0.7" />
        </svg>
      </div>
    );
  }

  return (
    <div className={`entity-photo entity-photo-${size}`}>
      {/* Signed URLs are short-lived and remote by design - a plain img
          is the right element here, not next/image optimization. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} />
    </div>
  );
}

interface PhotoUploadProps {
  entityType: PhotoEntityType;
  entityId: string;
  /** Resource name for the follow-up PATCH (trucks/drivers/trailers). */
  resource: string;
  hasPhoto: boolean;
  onUploaded: (documentId: string) => void;
}

// Upload (or replace) the entity's photo: file picker -> documents
// upload -> PATCH photo_document_id at the new document. The old photo
// document stays in the entity's documents (original kept), it just
// stops being the displayed one.
export function PhotoUpload({ entityType, entityId, resource, hasPhoto, onUploaded }: PhotoUploadProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const doc = await apiClient.uploadDocument<Document>({
        file,
        related_entity_type: entityType,
        related_entity_id: entityId,
        file_name: "photo",
      });
      await apiClient.update(resource, entityId, { photo_document_id: doc.id });
      onUploaded(doc.id);
    } catch {
      setError("That photo didn't upload. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="photo-upload">
      <label className="photo-upload-button">
        {busy ? "Uploading…" : hasPhoto ? "Replace photo" : "Add a photo"}
        <input
          type="file"
          accept="image/*"
          onChange={handleChange}
          disabled={busy}
          className="photo-upload-input"
        />
      </label>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
