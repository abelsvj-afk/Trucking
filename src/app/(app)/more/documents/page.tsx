"use client";

// Task 3.10 (TASKS.md). "Browsable from its related truck/trailer/driver/load"
// (the task's acceptance criterion) doesn't require a detail page per
// entity - none exist yet, and building four just for this would be scope
// creep. Instead: pick a type, pick the specific record (via the same
// usePickerList hook every relationship dropdown already uses), see and
// manage that record's documents.

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import { ListLoading, ListEmpty, ListError, TeachingEmpty } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import ListRow from "@/components/ListRow";
import { DOC_TYPE_LABELS, extractionStatusText, SITUATION_LABELS } from "@/lib/document-labels";
import ConfirmDialog from "@/components/ConfirmDialog";
import Field from "@/components/Field";
import CreateDocumentForm from "@/components/CreateDocumentForm";
import { usePageTitle } from "@/lib/use-page-title";
import type {
  CleanupIncident,
  Driver,
  DocumentWithSignedUrl,
  Expense,
  Load,
  RelatedEntityType,
  Trailer,
  Truck,
} from "@/types/entities";
import { formatDate } from "@/lib/time";
import { formatMoney } from "@/lib/money-format";

const ENTITY_TYPES: { label: string; value: RelatedEntityType; resource: string }[] = [
  { label: "Truck", value: "truck", resource: "trucks" },
  { label: "Trailer", value: "trailer", resource: "trailers" },
  { label: "Driver", value: "driver", resource: "drivers" },
  { label: "Load", value: "load", resource: "loads" },
  { label: "Expense", value: "expense", resource: "expenses" },
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
  const text = doc.extracted_text ?? (doc.model ? `${doc.model.title} ${doc.model.sections.flatMap((s) => s.lines).join(" ")}` : null);
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

function labelFor(entityType: RelatedEntityType, record: Truck | Trailer | Driver | Load | Expense) {
  if (entityType === "driver") return (record as Driver).name;
  if (entityType === "load") {
    const load = record as Load;
    return `${load.origin} → ${load.destination}`;
  }
  if (entityType === "expense") {
    const expense = record as Expense;
    return `${formatMoney(expense.amount_cents)} — ${expense.category} — ${expense.expense_date}${expense.description ? ` — ${expense.description}` : ""}`;
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
    paramType === "trailer" || paramType === "driver" || paramType === "load" || paramType === "expense"
      ? paramType
      : "truck";
  const [entityType, setEntityType] = useState<RelatedEntityType>(initialType);
  const [entityId, setEntityId] = useState(() => searchParams.get("related_entity_id") ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [docsState, setDocsState] = useState<DocsState>({ status: "loaded", documents: [] });
  const [recentDocs, setRecentDocs] = useState<DocumentWithSignedUrl[]>([]);
  const [pendingRemove, setPendingRemove] = useState<DocumentWithSignedUrl | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });
  // Cleanup incidents (Unit A / F-038 surface): leftover files whose
  // automatic cleanup failed, with a working retry - never silent.
  const [incidents, setIncidents] = useState<CleanupIncident[]>([]);
  const [incidentNotice, setIncidentNotice] = useState<string | null>(null);
  // Deleted documents for the selected record (Unit A / F-007):
  // tombstones with retention status and a restore action.
  const [showDeletedDocs, setShowDeletedDocs] = useState(false);
  const [deletedDocs, setDeletedDocs] = useState<DocumentWithSignedUrl[]>([]);
  const [deletedNotice, setDeletedNotice] = useState<string | null>(null);

  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const drivers = usePickerList<Driver>("drivers");
  const loads = usePickerList<Load>("loads");
  const expenses = usePickerList<Expense>("expenses");
  const [uploadDocType, setUploadDocType] = useState("");
  const [uploadSituation, setUploadSituation] = useState("");

  const recordsByType: Record<RelatedEntityType, (Truck | Trailer | Driver | Load | Expense)[]> = {
    truck: trucks,
    trailer: trailers,
    driver: drivers,
    load: loads,
    expense: expenses,
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

  // Recent list (Phase 3): latest ~25 across all records, above the picker.
  useEffect(() => {
    let cancelled = false;
    apiClient
      .listRecentDocuments<DocumentWithSignedUrl>(25)
      .then((result) => { if (!cancelled) setRecentDocs(result.data); })
      .catch(() => { if (!cancelled) setRecentDocs([]); });
    return () => { cancelled = true; };
  }, []);

  const fetchIncidents = useCallback(() => {
    apiClient
      .listCleanupIncidents<CleanupIncident>()
      .then((result) => setIncidents(result.data))
      .catch(() => setIncidents([]));
  }, []);

  useEffect(() => {
    fetchIncidents();
  }, [fetchIncidents]);

  const fetchDeletedDocuments = useCallback(() => {
    if (!entityId) return;
    apiClient
      .listDeletedDocuments<DocumentWithSignedUrl>(entityType, entityId)
      .then((result) => setDeletedDocs(result.data))
      .catch(() => setDeletedDocs([]));
  }, [entityType, entityId]);

  useEffect(() => {
    if (showDeletedDocs) fetchDeletedDocuments();
  }, [showDeletedDocs, fetchDeletedDocuments]);

  async function handleRetryIncident(id: string) {
    setIncidentNotice(null);
    try {
      const updated = await apiClient.retryCleanupIncident<CleanupIncident>(id);
      if (updated.status === "open") {
        setIncidentNotice("That file still couldn't be removed — the incident stays open below.");
        fetchIncidents();
      } else {
        setIncidentNotice(
          updated.status === "object_absent"
            ? "That leftover file was already gone — incident closed."
            : "Leftover file removed — incident closed.",
        );
        fetchIncidents();
      }
    } catch {
      setIncidentNotice("Couldn't retry cleanup. Try again.");
    }
  }

  async function handleRestoreDocument(id: string) {
    setDeletedNotice(null);
    try {
      await apiClient.restoreDocument(id);
      setDeletedNotice("Document restored.");
      fetchDeletedDocuments();
      fetchDocuments();
    } catch (err) {
      setDeletedNotice(
        err instanceof ApiClientError ? err.message : "Couldn't restore that document. Try again.",
      );
    }
  }

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
        doc_type: uploadDocType || undefined,
        situation: uploadSituation || undefined,
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
        purpose="Paperwork and photos, filed against the truck, trailer, driver, load, or expense they belong to — BOLs, permits, registrations, receipts. The assistant can read these — and create documents here too."
      />

      {incidents.length > 0 && (
        <section aria-label="Files needing cleanup">
          <h2>Leftover files needing cleanup</h2>
          <p className="row-sub">
            These files were uploaded but their automatic cleanup failed, so no record points
            at them. Retry the removal here — an incident only closes when the file is
            actually gone or confirmed absent.
          </p>
          {incidentNotice && <p role="status">{incidentNotice}</p>}
          <ul>
            {incidents.map((incident) => (
              <li key={incident.id}>
                {incident.storage_path}{" "}
                <span className="row-sub">
                  recorded {formatDate(incident.created_at, "America/New_York")}
                </span>{" "}
                <button type="button" onClick={() => handleRetryIncident(incident.id)}>
                  Retry removal
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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
              <Link href={`/more/documents/${doc.id}`}>View</Link>
              {snippet(doc) && <p>{snippet(doc)}</p>}
            </li>
          ))}
        </ul>
      )}

      <section aria-label="Recent documents">
        <h2>Recent</h2>
        {recentDocs.length === 0 && <p className="row-sub">No documents filed yet.</p>}
        <div>
          {recentDocs.map((doc) => (
            <Link key={doc.id} href={`/more/documents/${doc.id}`} style={{ textDecoration: "none", color: "inherit", display: "block", marginBottom: "8px" }}>
              <ListRow
                title={doc.doc_type ? (DOC_TYPE_LABELS[doc.doc_type] ?? doc.file_name) : doc.file_name}
                sub={`${doc.file_name} · ${doc.related_entity_type} · ${formatDate(doc.uploaded_at, "America/New_York")}`}
                action={<span aria-hidden="true">›</span>}
              />
            </Link>
          ))}
        </div>
      </section>

      {/* Type / Record filters (conformance fix D6): these were bare
          label+select children of the page root — the global label and
          select top margins stacked in the flex column and the labels
          overlapped the control above. The design-system Field wrapper
          (spec §2.6) owns the label/control rhythm instead. */}
      <div className="documents-filters">
        <Field label="Type" htmlFor="entity_type">
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
        </Field>

        <Field label="Record" htmlFor="entity_id">
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
        </Field>
      </div>

      {entityId && (
        <form onSubmit={handleUpload}>
          <label htmlFor="file">File</label>
          <input
            id="file"
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
          <label htmlFor="upload_doc_type">What kind of document is it? (optional)</label>
          <select id="upload_doc_type" value={uploadDocType} onChange={(event) => setUploadDocType(event.target.value)}>
            <option value="">Kind not set</option>
            <option value="receipt">Receipt</option>
            <option value="agreement">Agreement</option>
            <option value="invoice">Invoice</option>
            <option value="statement">Statement</option>
            <option value="settlement">Settlement</option>
            <option value="bol">Bill of lading</option>
            <option value="rate_confirmation">Rate confirmation</option>
            <option value="scale_ticket">Scale ticket</option>
            <option value="fuel_receipt">Fuel receipt</option>
            <option value="other">Other</option>
          </select>
          <label htmlFor="upload_situation">Which books does it belong to? (optional)</label>
          <select id="upload_situation" value={uploadSituation} onChange={(event) => setUploadSituation(event.target.value)}>
            <option value="">Situation not set</option>
            <option value="carrier">Working for a carrier</option>
            <option value="own_authority">Own authority</option>
            <option value="business_records">Business records</option>
          </select>
          {uploadError && <p role="alert">{uploadError}</p>}
          <button type="submit" disabled={uploading || !file}>
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </form>
      )}

      {entityId && (
        <CreateDocumentForm
          key={`${entityType}:${entityId}`}
          entityType={entityType}
          entityId={entityId}
          onCreated={fetchDocuments}
        />
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
              {doc.signed_url && /\.(jpe?g|png|webp|heic|heif)$/i.test(doc.file_name) && (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, not Next-optimizable */}
                  <img src={doc.signed_url} alt="" style={{ width: "56px", height: "56px", objectFit: "cover", verticalAlign: "middle" }} />{" "}
                </>
              )}
              <Link href={`/more/documents/${doc.id}`}>{doc.file_name}</Link>{" "}
              <Link href={`/more/documents/${doc.id}`}>View</Link>{" "}
              <button type="button" onClick={() => setPendingRemove(doc)}>
                Remove
              </button>
              <p>
                {extractionStatusText(doc)}
                {doc.situation ? ` · ${SITUATION_LABELS[doc.situation] ?? doc.situation}` : ""}
                {doc.source === "generated" ? " · Created in the app" : ""}
              </p>
            </li>
          ))}
        </ul>
      )}

      {entityId && (
        <section aria-label="Deleted documents">
          <p>
            <button
              type="button"
              onClick={() => setShowDeletedDocs((current) => !current)}
              aria-pressed={showDeletedDocs}
            >
              {showDeletedDocs ? "Hide deleted documents" : "Deleted documents"}
            </button>
          </p>
          {showDeletedDocs && (
            <div>
              <p className="row-sub">
                Removing a document keeps its file — nothing here is erased. Restore brings
                the document back exactly as it was.
              </p>
              {deletedNotice && <p role="status">{deletedNotice}</p>}
              {deletedDocs.length === 0 && <p>No deleted documents for this record.</p>}
              {deletedDocs.length > 0 && (
                <ul>
                  {deletedDocs.map((doc) => (
                    <li key={doc.id}>
                      {doc.file_name}{" "}
                      <span className="row-sub">
                        {doc.deleted_at
                          ? `Removed ${formatDate(doc.deleted_at, "America/New_York")}`
                          : ""}
                        {doc.retention_status ? ` · file ${doc.retention_status}` : ""}
                      </span>{" "}
                      <button type="button" onClick={() => handleRestoreDocument(doc.id)}>
                        Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove this document?"
        message={
          pendingRemove
            ? `Remove "${pendingRemove.file_name}"? It moves to Deleted documents, where you can restore it.`
            : ""
        }
        confirmLabel="Remove"
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (!pendingRemove) return;
          const id = pendingRemove.id;
          setPendingRemove(null);
          void handleRemove(id);
        }}
      />
    </div>
  );
}
