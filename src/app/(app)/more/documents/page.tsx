"use client";

// Task 3.10 (TASKS.md). "Browsable from its related truck/trailer/driver/load"
// (the task's acceptance criterion) doesn't require a detail page per
// entity - none exist yet, and building four just for this would be scope
// creep. Instead: pick a type, pick the specific record (via the same
// usePickerList hook every relationship dropdown already uses), see and
// manage that record's documents.

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import { ListLoading, ListEmpty, ListError, TeachingEmpty } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { DocumentPreview, extractionStatusText } from "@/components/DocumentPreview";
import { usePageTitle } from "@/lib/use-page-title";
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

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; documents: DocumentWithSignedUrl[] };

/** A short excerpt of what the assistant read, for search results. */
function snippet(doc: DocumentWithSignedUrl): string | null {
  if (!doc.extracted_text) return null;
  const flat = doc.extracted_text.replace(/\s+/g, " ").trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

function labelFor(entityType: RelatedEntityType, record: Truck | Trailer | Driver | Load) {
  if (entityType === "driver") return (record as Driver).name;
  if (entityType === "load") {
    const load = record as Load;
    return `${load.origin} → ${load.destination}`;
  }
  return (record as Truck | Trailer).unit_number;
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={<p>Loading documents…</p>}>
      <DocumentsInner />
    </Suspense>
  );
}

function DocumentsInner() {
  usePageTitle("Documents");
  // UI/UX upgrade: detail screens (a truck, a driver, a load) link
  // straight here with the record preselected - the params only set
  // the INITIAL picker state; the pickers stay fully usable after.
  const searchParams = useSearchParams();
  const paramType = searchParams.get("related_entity_type");
  const initialType: RelatedEntityType =
    paramType === "trailer" || paramType === "driver" || paramType === "load" ? paramType : "truck";
  const [entityType, setEntityType] = useState<RelatedEntityType>(initialType);
  const [entityId, setEntityId] = useState(() => searchParams.get("related_entity_id") ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [docsState, setDocsState] = useState<DocsState>({ status: "loaded", documents: [] });
  const [previewDoc, setPreviewDoc] = useState<DocumentWithSignedUrl | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });

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
      setPreviewDoc((current) => (current?.id === id ? null : current));
      fetchDocuments();
    } catch {
      setUploadError("Couldn't remove that document. Try again.");
    }
  }

  // Full-text search across every document's extracted text
  // (docs/api-contracts.md) - pickup numbers, cities, amounts,
  // anything the paperwork says, not just one record's files.
  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchText.trim();
    if (!query) return;
    setSearchState({ status: "loading" });
    apiClient
      .searchDocuments<DocumentWithSignedUrl>(query)
      .then((result) => setSearchState({ status: "loaded", documents: result.data }))
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again.";
        setSearchState({ status: "error", message });
      });
  }

  return (
    <div>
      <PageHeader
        title="Documents"
        purpose="Paperwork and photos, filed against the truck, trailer, driver, or load they belong to — BOLs, permits, registrations, receipts. The assistant can read these."
      />

      <form onSubmit={handleSearch}>
        <label htmlFor="document_search">Search your paperwork</label>
        <input
          id="document_search"
          type="search"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="Pickup number, city, amount…"
        />
        <button type="submit" disabled={!searchText.trim()}>
          Search
        </button>
      </form>

      {searchState.status === "loading" && <ListLoading />}
      {searchState.status === "error" && (
        <ListError message={searchState.message} onRetry={() => setSearchState({ status: "idle" })} />
      )}
      {searchState.status === "loaded" && searchState.documents.length === 0 && (
        <ListEmpty message="No documents match that search yet. Text search covers documents whose text has been extracted." />
      )}
      {searchState.status === "loaded" && searchState.documents.length > 0 && (
        <ul>
          {searchState.documents.map((doc) => (
            <li key={doc.id}>
              {doc.file_name} ({doc.related_entity_type}){" "}
              <button type="button" onClick={() => setPreviewDoc(doc)}>
                View
              </button>
              {snippet(doc) && <p>{snippet(doc)}</p>}
            </li>
          ))}
        </ul>
      )}

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

      {entityId && docsState.status === "loading" && <ListLoading />}
      {entityId && docsState.status === "error" && (
        <ListError message={docsState.message} onRetry={fetchDocuments} />
      )}
      {entityId && docsState.status === "loaded" && docsState.documents.length === 0 && (
        <TeachingEmpty
          title="Nothing filed here yet"
          message="Upload the first document for this record above — a BOL photo, a permit scan, a registration. Filed here, the assistant can find and read it later."
        />
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
              <button type="button" onClick={() => setPreviewDoc(doc)}>
                View
              </button>{" "}
              <button type="button" onClick={() => handleRemove(doc.id)}>
                Remove
              </button>
              <p>{extractionStatusText(doc)}</p>
            </li>
          ))}
        </ul>
      )}

      {previewDoc && <DocumentPreview key={previewDoc.id} doc={previewDoc} />}
    </div>
  );
}
