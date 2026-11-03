"use client";

// Driver MVP (docs/design/driver-mvp.md §3). The duty-log list plus the
// warn-only summary from lib/hos.ts. Labeled everywhere it appears:
// this is a paper-log helper, not an ELD, and never the legal record.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import { summarizeHos } from "@/lib/hos";
import type { Document, DutyLog } from "@/types/entities";

const STATUS_LABELS: Record<DutyLog["duty_status"], string> = {
  off_duty: "Off duty",
  sleeper: "Sleeper",
  driving: "Driving",
  on_duty: "On duty (not driving)",
};

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export default function HosPage() {
  usePageTitle("Hours of service");
  const { state, retry } = useApiList<DutyLog>("duty-logs", { limit: "200" });
  // Paper-log provenance (Image Intelligence §7.5/§7.7): a sheet's
  // completeness stamp lives on its document row; the clocks built
  // on a partial day must say partial on this surface too.
  const documents = useApiList<Document>("documents", { limit: "200" });
  const paperDocs = new Map<string, { complete: boolean; date: string | null }>();
  if (documents.state.status === "loaded") {
    for (const doc of documents.state.result.data) {
      if (doc.photo_purpose !== "paper_log") continue;
      const fields = (doc.extracted_fields ?? {}) as Record<string, unknown>;
      paperDocs.set(doc.id, {
        complete: fields.paper_log_complete !== false,
        date: typeof fields.paper_log_date === "string" ? fields.paper_log_date : null,
      });
    }
  }

  const summary =
    state.status === "loaded" ? summarizeHos(state.result.data) : null;
  const rows = state.status === "loaded" ? state.result.data : [];
  const paperRowCount = rows.filter((row) => row.source === "paper_photo").length;
  const partialDates = [
    ...new Set(
      rows
        .filter((row) => row.source_document_id && paperDocs.get(row.source_document_id)?.complete === false)
        .map((row) => paperDocs.get(row.source_document_id!)?.date ?? "that day"),
    ),
  ];

  return (
    <div>
      <PageHeader
        title="Hours of service"
        purpose="Track your hours so you never run illegal — every status change you log, turned into what's left today and this week."
      />
      <p>
        <strong>Paper-log helper, not an ELD.</strong> These numbers come
        from what you log here by hand. The truck&apos;s ELD (or your
        official paper logs) is the legal record - if the two ever
        disagree, the ELD/official log wins.
      </p>
      <Link href="/fleet/hos/new">Log duty status</Link>

      {summary && state.status === "loaded" && state.result.data.length > 0 && (
        <section aria-label="Summary">
          <h2>Where you stand</h2>
          <ul>
            <li>Driving in this 14-hour window: {formatMinutes(summary.drivingMinutesInWindow)} of 11h</li>
            <li>Window elapsed: {formatMinutes(summary.windowElapsedMinutes)} of 14h</li>
            <li>Driving since your last 30-minute break: {formatMinutes(summary.drivingMinutesSinceBreak)} of 8h</li>
            <li>On duty in the last 8 days: {formatMinutes(summary.onDutyMinutesLast8Days)} of 70h</li>
          </ul>
          {summary.warnings.map((warning) => (
            <p key={warning} role="alert">
              {warning}
            </p>
          ))}
          {paperRowCount > 0 && (
            <p>
              {paperRowCount === rows.length
                ? "Every hour above was read off your paper log sheet(s) — the paper stays the legal record; this page mirrors it."
                : "The hours above mix what you logged here with hours read off your paper log sheet(s) — where they differ, the paper is the legal record."}
            </p>
          )}
          {partialDates.map((date) => (
            <p key={date} role="alert">
              Partial — from the readable part of {date}&apos;s log; the unreadable spans aren&apos;t in these numbers.
            </p>
          ))}
        </section>
      )}

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <TeachingEmpty
          title="No duty statuses logged yet"
          message="Tap Log duty status each time your status changes — off duty, sleeper, driving, on duty. From those taps this screen computes your 11-hour drive limit, 14-hour window, 8-hour break, and 70-hour week, and warns you before you run past one."
          action={<Link href="/fleet/hos/new">Log your first status</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {[...state.result.data]
            .sort((a, b) => b.started_at.localeCompare(a.started_at))
            .map((row) => (
              <li key={row.id}>
                {STATUS_LABELS[row.duty_status]} —{" "}
                {new Date(row.started_at).toLocaleString()}
                {row.location ? ` — ${row.location}` : ""}
                {row.notes ? ` — ${row.notes}` : ""}
                {row.source === "paper_photo" ? " — from your paper log sheet" : ""}
                {row.source === "conversation" ? " — from your words" : ""}
                {row.source_document_id &&
                paperDocs.get(row.source_document_id)?.complete === false
                  ? " (partial day)"
                  : ""}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
