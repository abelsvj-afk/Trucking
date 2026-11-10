"use client";

// RETIRED as an editor (UI/UX spec 2026-11-10 §2.2/§2.8 step 3): the
// day view's unified sheet is the ONE duty-log editor now, so this
// route no longer carries its own 7-field form. The route itself
// stays (coverage rule - no route dies):
//   - a LIVE entry redirects to the Day log with that entry's editor
//     open (/fleet/hos?entry=<id>, resolved by id, never by position);
//   - a SOFT-DELETED entry keeps ONLY its restore UI here - the
//     deleted-restore path (RecordLifecycle on the Day log page does
//     the same job in list form) must not break, and restoring from
//     this page lands back on the entry's editor.
// Paper-log helper, not an ELD - the legal record is unchanged.

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import { formatDateTime } from "@/lib/time";
import type { DutyLog } from "@/types/entities";

const STATUS_LABELS: Record<DutyLog["duty_status"], string> = {
  off_duty: "Off duty",
  sleeper: "Sleeper",
  driving: "Driving",
  on_duty: "On duty (not driving)",
};

type Phase =
  | { kind: "loading" }
  | { kind: "deleted"; row: DutyLog }
  | { kind: "missing" }
  | { kind: "error" };

export default function DutyLogDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Duty log");
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Live entry: hand over to the one editor.
        await apiClient.get<DutyLog>("duty-logs", id);
        if (!cancelled) router.replace(`/fleet/hos?entry=${id}`);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 404) {
          // Not live - it may be soft-deleted, in which case ONLY the
          // restore UI belongs here.
          try {
            const result = await apiClient.list<DutyLog>("duty-logs", { deleted: "only", limit: "200" });
            const found = result.data.find((row) => row.id === id);
            if (!cancelled) setPhase(found ? { kind: "deleted", row: found } : { kind: "missing" });
          } catch {
            if (!cancelled) setPhase({ kind: "error" });
          }
        } else {
          setPhase({ kind: "error" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  async function restore(row: DutyLog) {
    setRestoring(true);
    setRestoreError(null);
    try {
      await apiClient.restore<DutyLog>("duty-logs", row.id);
      router.replace(`/fleet/hos?entry=${row.id}`);
    } catch (err) {
      // A 422 refusal names its reason (a deleted parent, a record
      // that no longer validates) - show it as-is.
      setRestoreError(err instanceof ApiClientError ? err.message : "Couldn't restore. Try again.");
      setRestoring(false);
    }
  }

  if (phase.kind === "loading") {
    return (
      <div>
        <PageHeader title="Duty log" purpose="One duty status, in full. Paper-log helper, not an ELD." />
        <ListLoading />
        <p className="row-sub">Opening this entry in the day log…</p>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div>
        <PageHeader title="Duty log" purpose="One duty status, in full. Paper-log helper, not an ELD." />
        <ListError message="Couldn't load this duty log. Check the connection and try again." onRetry={() => window.location.reload()} />
      </div>
    );
  }

  if (phase.kind === "missing") {
    return (
      <div>
        <PageHeader title="Duty log" purpose="One duty status, in full. Paper-log helper, not an ELD." />
        <p>That duty entry isn&apos;t in your records.</p>
        <p>
          <Link href="/fleet/hos">Back to the day log</Link>
        </p>
      </div>
    );
  }

  const row = phase.row;
  const recordName = `${STATUS_LABELS[row.duty_status]} — ${formatDateTime(row.started_at)}`;
  return (
    <div>
      <PageHeader title={recordName} purpose="One duty status, in full. Paper-log helper, not an ELD." />
      <section aria-label="Deleted entry">
        <h2>This entry was deleted</h2>
        <dl>
          <dt>Duty status</dt>
          <dd>{STATUS_LABELS[row.duty_status]}</dd>
          <dt>Started at</dt>
          <dd>{formatDateTime(row.started_at)}</dd>
          <dt>Location</dt>
          <dd>{row.location ?? "Not recorded"}</dd>
          <dt>Notes</dt>
          <dd>{row.notes ?? "None"}</dd>
        </dl>
        <p>
          Deleted entries are kept, not erased. Restoring brings this entry back exactly as it was — unless
          something it depends on was also deleted, in which case the reason is shown here.
        </p>
        {restoreError && <p role="alert">{restoreError}</p>}
        <button type="button" onClick={() => void restore(row)} disabled={restoring}>
          {restoring ? "Restoring…" : "Restore this entry"}
        </button>
      </section>
      <p>
        <Link href="/fleet/hos">Back to the day log</Link>
      </p>
    </div>
  );
}
