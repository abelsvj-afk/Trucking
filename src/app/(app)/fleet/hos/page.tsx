"use client";

// Driver MVP (docs/design/driver-mvp.md §3). The duty-log list plus the
// warn-only summary. Labeled everywhere it appears: this is a paper-log
// helper, not an ELD, and never the legal record.
//
// Reliability Unit B (design B.2.4/B.2.5, F-013/F-015): the summary is
// computed from the dedicated duty-log WINDOW fetch (every log in the
// carrier-anchored calculation window, ascending - never the capped,
// newest-first display list). The weekly figure is the
// carrier-anchored cycle (lib/hos-cycle.ts): current + previous
// carrier periods from the carrier's configured anchor and timezone,
// with the basis stated on the surface. The short-term figures
// (14-hour window, 11-hour driving, 30-minute break) still come from
// lib/hos.ts, fed the same window rows so both engines segment the
// same history.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { useHosWindow } from "@/lib/use-hos-window";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import { summarizeHos } from "@/lib/hos";
import { formatDate, formatDateTime } from "@/lib/time";
import {
  useDeletedToggle,
  DeletedToggleButton,
  DeletedListSection,
} from "@/components/RecordLifecycle";
import { buildPaperDocMap, hosPaperBanner, hosPartialLines, hosRowPaperSuffix } from "@/lib/hos-paper";
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
  const [showDeleted, setShowDeleted] = useDeletedToggle();
  const { state, retry } = useApiList<DutyLog>("duty-logs", { limit: "200" });
  const hosWindow = useHosWindow();

  // Short-term summary over the WINDOW rows (complete history), not
  // the display list. hos.ts's own rolling 8-day figure and warning
  // are superseded by the carrier-anchored cycle below and filtered
  // out - showing both would state two different weekly totals.
  const shortTerm =
    hosWindow.state.status === "loaded" ? summarizeHos(hosWindow.state.data) : null;
  const shortTermWarnings = (shortTerm?.warnings ?? []).filter(
    (warning) => !warning.includes("8-day on-duty limit"),
  );
  const hos = hosWindow.state.status === "loaded" ? hosWindow.state.hos : null;
  const hasAnyLogs =
    hosWindow.state.status === "loaded" ? hosWindow.state.data.length > 0 : state.status === "loaded" && state.result.data.length > 0;

  // Paper-log provenance (Image Intelligence §7.5/§7.7): a sheet's
  // completeness stamp lives on its document row; the clocks built
  // on a partial day must say partial on this surface too.
  const documents = useApiList<Document>("documents", { limit: "200" });
  // UH-12 fix: the paper/partial computation lives in the shared
  // helper (src/lib/hos-paper.ts) — Home consumes the same labels.
  const paperDocs =
    documents.state.status === "loaded" ? buildPaperDocMap(documents.state.result.data) : new Map();
  const rows = state.status === "loaded" ? state.result.data : [];
  const paperBanner = hosPaperBanner(rows, paperDocs);
  const partialLines = hosPartialLines(rows, paperDocs);

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
      <p>
        <Link href="/fleet/hos/new">Log duty status</Link> ·{" "}
        <Link href="/fleet/hos/paper">Paper logs — photograph a sheet</Link>
      </p>

      <DeletedToggleButton showDeleted={showDeleted} onChange={setShowDeleted} listLabel="duty logs" />

      {showDeleted ? (
        <DeletedListSection<DutyLog>
          resource="duty-logs"
          labelFor={(row) =>
            `${STATUS_LABELS[row.duty_status]} — ${formatDate(row.started_at)}`
          }
          sublabelFor={(row) => row.location ?? null}
        />
      ) : (
        <>
      {hosWindow.state.status === "error" && (
        <section aria-label="Summary">
          <h2>Where you stand</h2>
          <p role="alert">
            Your summary couldn&apos;t be computed completely, so it isn&apos;t
            shown rather than risk understating your hours: {hosWindow.state.message}{" "}
            <button type="button" onClick={hosWindow.retry}>Retry</button>
          </p>
        </section>
      )}
      {shortTerm && hos && hasAnyLogs && (
        <section aria-label="Summary">
          <h2>Where you stand</h2>
          <ul>
            <li>Driving in this 14-hour window: {formatMinutes(shortTerm.drivingMinutesInWindow)} of 11h</li>
            <li>Window elapsed: {formatMinutes(shortTerm.windowElapsedMinutes)} of 14h</li>
            <li>Driving since your last 30-minute break: {formatMinutes(shortTerm.drivingMinutesSinceBreak)} of 8h</li>
            <li>
              On duty this cycle ({hos.cycle}): {formatMinutes(hos.onDutyMinutesInCycle)} of{" "}
              {formatMinutes(hos.cycleLimitMinutes)}
            </li>
          </ul>
          <p>
            Cycle basis: current + previous {hos.cycle === "70/8" ? 7 : 6} carrier periods
            (the {hos.cycle} cycle), each starting at {hos.periodAnchor} {hos.carrierTimeZone} —
            your carrier&apos;s specified period start, not calendar days.
          </p>
          {hos.restartApplied && (
            <p>
              Cycle restarted — 34-hour restart ended{" "}
              {formatDateTime(hos.restartApplied.endedAt, hos.carrierTimeZone)} ({hos.carrierTimeZone});
              duty before it doesn&apos;t count toward this cycle.
            </p>
          )}
          {hos.restartUnverified && (
            <p role="alert">
              A possible 34-hour restart couldn&apos;t be verified from the visible
              log, so it wasn&apos;t applied — this total is the conservative
              full-cycle count.
            </p>
          )}
          {shortTermWarnings.map((warning) => (
            <p key={warning} role="alert">
              {warning}
            </p>
          ))}
          {hos.warnings.map((warning) => (
            <p key={warning} role="alert">
              {warning}
            </p>
          ))}
          {paperBanner && <p>{paperBanner}</p>}
          {partialLines.map((line) => (
            <p key={line} role="alert">
              {line}
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
                <Link href={`/fleet/hos/${row.id}`}>
                  {STATUS_LABELS[row.duty_status]} —{" "}
                  {formatDateTime(row.started_at)}
                  {row.location ? ` — ${row.location}` : ""}
                  {row.notes ? ` — ${row.notes}` : ""}
                </Link>
                {hosRowPaperSuffix(row, paperDocs)}
              </li>
            ))}
        </ul>
      )}
        </>
      )}
    </div>
  );
}
