"use client";

// Task 3.10 (TASKS.md). "Browsable from its related truck/trailer/driver/load"
// (the task's acceptance criterion) doesn't require a detail page per
// entity - none exist yet, and building four just for this would be scope
// creep. Instead: pick a type, pick the specific record (via the same
// usePickerList hook every relationship dropdown already uses), see and
// manage that record's documents.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import type {
  Driver,
  DocumentWithSignedUrl,
  Load,
  RelatedEntityType,
  Trailer,
  Truck,
} from "@/types/entities";

const ENTITY_TYPES: { label: string; value: RelatedEntityType; resource: string }[] = [
  { label: "Truck", value: "truck", resource: "trucks" },
  { label: "Trailer", value: "trailer", resource: "trailers" },
  { label: "Driver", value: "driver", resource: "drivers" },
  { label: "Load", value: "load", resource: "loads" },
];

type DocsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; documents: DocumentWithSignedUrl[] };

function labelFor(entityType: RelatedEntityType, record: Truck | Trailer | Driver | Load) {
  if (entityType === "driver") return (record as Driver).name;
  if (entityType === "load") {
    const load = record as Load;
    return `${load.origin} → ${load.destination}`;
  }
  return (record as Truck | Trailer).unit_number;
}

export default function DocumentsPage() {
  const [entityType, setEntityType] = useState<RelatedEntityType>("truck");
  const [entityId, setEntityId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [docsState, setDocsState] = useState<DocsState>({ status: "loaded", documents: [] });

  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const drivers = usePickerList<Driver>("drivers");
  const loads = usePickerList<Load>("loads");

  const recordsByType: Record<RelatedEntityType, (Truck | Trailer | Driver | Load)[]> = {
    truck: trucks,
    trailer: trailers,
    driver: drivers,
    load: loads,
  };
  const records = recordsByType[entityType];

  const fetchDocuments = useCallback(() => {
    // No record picked - nothing to fetch; the list section is only
    // rendered when entityId is set. Only the async .then()/.catch() below
    // ever calls setState - never synchronously here - so this stays safe
    // to call from the effect body, same discipline as lib/use-api-list.ts.
    if (!entityId) return;

    apiClient
      .listDocuments<DocumentWithSignedUrl>(entityType, entityId)
      .then((result) => setDocsState({ status: "loaded", documents: result.data }))
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again.";
        setDocsState({ status: "error", message });
      });
  }, [entityType, entityId]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // Picking a record is a user action (not an effect), so it's safe to set
  // loading state synchronously here - this is what actually shows the
  // loading state on selection, since fetchDocuments itself never does.
  function handleEntityChange(id: string) {
    setEntityId(id);
    setDocsState(id ? { status: "loading" } : { status: "loaded", documents: [] });
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !entityId) return;
    setUploadError(null);
    setUploading(true);

    try {
      await apiClient.uploadDocument({
        file,
        related_entity_type: entityType,
        related_entity_id: entityId,
      });
      setFile(null);
      fetchDocuments();
    } catch (err) {
      setUploadError(err instanceof ApiClientError ? err.message : "Upload failed. Try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove(id: string) {
    try {
      await apiClient.removeDocument(id);
      fetchDocuments();
    } catch {
      setUploadError("Couldn't remove that document. Try again.");
    }
  }

  return (
    <div>
      <h1>Documents</h1>

      <label htmlFor="entity_type">Type</label>
      <select
        id="entity_type"
        value={entityType}
        onChange={(event) => {
          setEntityType(event.target.value as RelatedEntityType);
          handleEntityChange("");
        }}
      >
        {ENTITY_TYPES.map((type) => (
          <option key={type.value} value={type.value}>
            {type.label}
          </option>
        ))}
      </select>

      <label htmlFor="entity_id">Record</label>
      <select
        id="entity_id"
        value={entityId}
        onChange={(event) => handleEntityChange(event.target.value)}
      >
        <option value="">Select a record</option>
        {records.map((record) => (
          <option key={record.id} value={record.id}>
            {labelFor(entityType, record)}
          </option>
        ))}
      </select>

      {entityId && (
        <form onSubmit={handleUpload}>
          <label htmlFor="file">File</label>
          <input
            id="file"
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
          {uploadError && <p role="alert">{uploadError}</p>}
          <button type="submit" disabled={uploading || !file}>
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </form>
      )}

      {entityId && docsState.status === "loading" && <p>Loading…</p>}
      {entityId && docsState.status === "error" && <p role="alert">{docsState.message}</p>}
      {entityId && docsState.status === "loaded" && docsState.documents.length === 0 && (
        <p>No documents yet for this record.</p>
      )}
      {entityId && docsState.status === "loaded" && docsState.documents.length > 0 && (
        <ul>
          {docsState.documents.map((doc) => (
            <li key={doc.id}>
              {doc.signed_url ? (
                <a href={doc.signed_url} target="_blank" rel="noreferrer">
                  {doc.file_name}
                </a>
              ) : (
                doc.file_name
              )}{" "}
              <button type="button" onClick={() => handleRemove(doc.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
