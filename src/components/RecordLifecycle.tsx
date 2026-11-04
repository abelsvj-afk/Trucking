"use client";

// Record lifecycle UI (Reliability Unit A, design A.3/A.4): the shared
// delete control and Deleted view used by every entity list/detail
// surface, written once here instead of copy-pasted per screen.
//
// Honesty rules baked in (A.3): the confirmation NAMES the record; the
// post-delete message offers a "View deleted record" ACTION - never a
// fake "Undo" (there is no undo; there is a Deleted view with a real
// restore behind safeguard checks); a restore refusal shows the
// server's named reason instead of a generic failure.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ListLoading, ListError } from "@/components/ListStates";

// List pages call this to get their Deleted toggle state, honoring the
// ?view=deleted deep link the post-delete message points at. The flip
// happens in a deferred callback, not synchronously in the effect
// body - the same set-state-in-effect discipline lib/use-api-list.ts
// documents (and the lint rule enforces).
export function useDeletedToggle(): [boolean, (show: boolean) => void] {
  const [showDeleted, setShowDeleted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("view") === "deleted") {
        setShowDeleted(true);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  return [showDeleted, setShowDeleted];
}

export function DeletedToggleButton({
  showDeleted,
  onChange,
  listLabel,
}: {
  showDeleted: boolean;
  onChange: (show: boolean) => void;
  listLabel: string;
}) {
  return (
    <p className="deleted-toggle">
      <button type="button" onClick={() => onChange(!showDeleted)} aria-pressed={showDeleted}>
        {showDeleted ? `Back to ${listLabel}` : "Deleted"}
      </button>
    </p>
  );
}

type DeletePhase =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "deleting" }
  | { kind: "done" }
  | { kind: "error"; message: string };

export function DeleteRecordButton({
  resource,
  id,
  recordName,
  listHref,
  listLabel,
}: {
  resource: string;
  id: string;
  recordName: string;
  listHref: string;
  listLabel: string;
}) {
  const [phase, setPhase] = useState<DeletePhase>({ kind: "idle" });

  async function confirmDelete() {
    setPhase({ kind: "deleting" });
    try {
      await apiClient.remove(resource, id);
      setPhase({ kind: "done" });
    } catch (err) {
      setPhase({
        kind: "error",
        message:
          err instanceof ApiClientError ? err.message : "Couldn't delete. Try again.",
      });
    }
  }

  if (phase.kind === "done") {
    return (
      <div role="status">
        <p>
          {recordName} deleted. It&apos;s out of the lists and totals, but it isn&apos;t
          gone — you can bring it back from the Deleted view.
        </p>
        <p>
          <Link href={`${listHref}?view=deleted`}>View deleted record</Link>
          {" · "}
          <Link href={listHref}>Back to {listLabel}</Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      {phase.kind === "idle" && (
        <button type="button" onClick={() => setPhase({ kind: "confirming" })}>
          Delete {recordName}
        </button>
      )}
      {(phase.kind === "confirming" || phase.kind === "deleting") && (
        <div role="alertdialog" aria-label={`Delete ${recordName}`}>
          <p>
            Delete {recordName}? It disappears from lists and totals, but it&apos;s kept —
            you can restore it from the Deleted view on the {listLabel} list.
          </p>
          <p>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={phase.kind === "deleting"}
            >
              {phase.kind === "deleting" ? "Deleting…" : `Delete ${recordName}`}
            </button>{" "}
            <button
              type="button"
              onClick={() => setPhase({ kind: "idle" })}
              disabled={phase.kind === "deleting"}
            >
              Keep it
            </button>
          </p>
        </div>
      )}
      {phase.kind === "error" && (
        <div>
          <p role="alert">{phase.message}</p>
          <button type="button" onClick={() => setPhase({ kind: "confirming" })}>
            Delete {recordName}
          </button>
        </div>
      )}
    </div>
  );
}

interface DeletedRowShape {
  id: string;
  deleted_at?: string | null;
}

export function DeletedListSection<Row extends DeletedRowShape>({
  resource,
  labelFor,
  sublabelFor,
}: {
  resource: string;
  labelFor: (row: Row) => string;
  sublabelFor?: (row: Row) => string | null;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(() => {
    apiClient
      .list<Row>(resource, { deleted: "only", limit: "100" })
      .then((result) => setRows(result.data))
      .catch(() =>
        setError("Couldn't load deleted records. Check the connection and try again."),
      );
  }, [resource]);

  useEffect(() => {
    load();
  }, [load]);

  async function restore(row: Row) {
    setNotice(null);
    setRestoringId(row.id);
    try {
      await apiClient.restore(resource, row.id);
      setRows((current) => (current ?? []).filter((r) => r.id !== row.id));
      setNotice(`${labelFor(row)} restored.`);
    } catch (err) {
      // A 422 refusal's message names the reason (a deleted parent, a
      // record that no longer validates) - show it as-is.
      setNotice(
        err instanceof ApiClientError ? err.message : "Couldn't restore. Try again.",
      );
    } finally {
      setRestoringId(null);
    }
  }

  if (error) return <ListError message={error} onRetry={load} />;
  if (rows === null) return <ListLoading />;
  return (
    <div>
      <h2>Deleted</h2>
      <p className="row-sub">
        Deleted records are kept, not erased. Restoring brings a record back exactly as
        it was — unless something it depends on was also deleted, in which case the
        reason is shown here.
      </p>
      {notice && <p role="status">{notice}</p>}
      {rows.length === 0 && <p>Nothing deleted here.</p>}
      {rows.length > 0 && (
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              <span className="row-text">
                <span className="row-title">{labelFor(row)}</span>
                <span className="row-sub">
                  {[
                    sublabelFor?.(row) ?? null,
                    row.deleted_at
                      ? `Deleted ${new Date(row.deleted_at).toLocaleDateString()}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>{" "}
              <button
                type="button"
                onClick={() => restore(row)}
                disabled={restoringId === row.id}
              >
                {restoringId === row.id ? "Restoring…" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
