"use client";

// Paper-log review (docs/design/driver-hud.md §6). The sheet photo beside
// the day recreated from it, stretch by stretch. Nothing is saved until
// he taps Save, and Save stays off until every minute of 00:00-24:00 is a
// status he has confirmed - a misread line silently saved would be a
// falsified log. Low confidence is loud, never hidden.

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import DayGraph from "@/components/paper/DayGraph";
import SegmentEditor, { STATUS_OPTIONS } from "@/components/paper/SegmentEditor";
import { usePageTitle } from "@/lib/use-page-title";
import { formatDateTime } from "@/lib/time";
import {
  dayTotals,
  formatMinutes,
  moveBoundary,
  removeSegment,
  setStatus,
  splitSegment,
  validateDraft,
  type DraftSegment,
} from "@/lib/paper-day";
import type { PaperLogReview } from "@/types/paper-logs";

const hours = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

export default function PaperLogReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Review paper log");
  const [review, setReview] = useState<PaperLogReview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftSegment[]>([]);
  const [logDate, setLogDate] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [replaceAck, setReplaceAck] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const accept = (r: PaperLogReview) => {
    setReview(r);
    setDraft(r.draft);
    setLogDate(r.log_date ?? "");
    setReplaceAck(false);
  };

  useEffect(() => {
    let cancelled = false;
    apiClient
      .paperLogReview(id)
      .then((res) => {
        if (!cancelled) accept(res.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof ApiClientError ? err.message : "Couldn't load this sheet.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function readNow() {
    setReading(true);
    setSaveError(null);
    try {
      accept((await apiClient.readPaperLog(id)).data);
    } catch (err) {
      setSaveError(err instanceof ApiClientError ? err.message : "Couldn't reach the server.");
    } finally {
      setReading(false);
    }
  }

  if (loadError) {
    return (
      <div>
        <PageHeader title="Review paper log" purpose="Check the day read from your sheet before it goes in your log." />
        <ListError message={loadError} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!review) return <ListLoading />;

  const validation = validateDraft(draft);
  const totals = dayTotals(draft);
  const needsAck = review.conflicts.length > 0;
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(logDate);
  const canSave = validation.ok && dateOk && (!needsAck || replaceAck) && !saving;
  const last = draft[draft.length - 1];

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiClient.savePaperLog(id, {
        log_date: logDate,
        segments: draft.map((s) => ({ status: s.status!, start_min: s.startMin, end_min: s.endMin })),
        replace_ids: replaceAck ? review!.conflicts.map((c) => c.id) : [],
      });
      setSaved(res.data.inserted);
    } catch (err) {
      setSaveError(err instanceof ApiClientError ? err.message : "No signal — nothing was saved. Try again when you're back online.");
    } finally {
      setSaving(false);
    }
  }

  if (saved !== null) {
    return (
      <div>
        <PageHeader title="Paper log saved" purpose="The day from your sheet is in your log." />
        <p role="status">
          Saved {logDate}: {saved} status change{saved === 1 ? "" : "s"}, marked as recreated from your paper sheet.
          Your paper stays the legal record.
        </p>
        {last?.status && (
          <p>
            Your log now continues from{" "}
            <strong>{STATUS_OPTIONS.find((o) => o.value === last.status)!.label.toLowerCase()}</strong> at the end of that
            day. Keep logging from Home — your next status change picks up from there.
          </p>
        )}
        <p>
          <Link href="/" className="page-action">
            Go to Home
          </Link>{" "}
          <Link href="/fleet/hos">Hours of service</Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Review paper log"
        purpose="Check each stretch against your sheet. Nothing goes in your log until you save."
      />

      <section aria-label="Your sheet" className="paper-photo">
        {review.photo_url ? (
          <a href={review.photo_url} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL, not a static asset */}
            <img src={review.photo_url} alt="Your paper log sheet" />
            <span className="row-sub">Tap to open full size</span>
          </a>
        ) : (
          <p>The photo couldn&apos;t be loaded right now.</p>
        )}
      </section>

      {!review.read && (
        <section aria-label="Not read yet" className="paper-notice">
          <p>
            This sheet hasn&apos;t been read yet. Read it now, or fill in the day yourself below — either way you
            confirm every stretch before it saves.
          </p>
          <button type="button" onClick={readNow} disabled={reading}>
            {reading ? "Reading the grid…" : "Read the grid"}
          </button>
        </section>
      )}

      <label htmlFor="paper-date">Date on the sheet</label>
      <input
        id="paper-date"
        type="date"
        value={logDate}
        onChange={(e) => setLogDate(e.target.value)}
      />
      {review.log_date === null && <p className="row-sub">The date couldn&apos;t be read — enter the date printed on the sheet.</p>}
      {review.log_date !== null && logDate !== review.log_date && (
        <p role="status" className="paper-notice">
          You changed the date from what was read ({review.log_date}). Saving checks the new date for entries already in
          your log and refuses if any would be overwritten without your OK.
        </p>
      )}
      <p className="row-sub">Times are placed in {review.time_zone} (your carrier time zone setting).</p>

      <DayGraph segments={draft} selected={selected} onSelect={setSelected} />

      {review.problems.length > 0 && (
        <section aria-label="Reader warnings" className="paper-notice">
          <h2>The reader&apos;s checks didn&apos;t all pass</h2>
          <ul>
            {review.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Day totals">
        <h2>Totals</h2>
        <table className="paper-totals">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Recreated</th>
              <th scope="col">On your sheet</th>
            </tr>
          </thead>
          <tbody>
            {STATUS_OPTIONS.map((o) => {
              const written = review.written_totals?.[o.value] ?? null;
              const mismatch = written !== null && Math.abs(written * 60 - totals[o.value]) > 1;
              return (
                <tr key={o.value} className={mismatch ? "paper-mismatch" : undefined}>
                  <th scope="row">{o.label}</th>
                  <td>{hours(totals[o.value])}</td>
                  <td>
                    {written === null ? "—" : hours(Math.round(written * 60))}
                    {mismatch && " ⚠ differs"}
                  </td>
                </tr>
              );
            })}
            {totals.unresolved > 0 && (
              <tr className="paper-mismatch">
                <th scope="row">Not yet confirmed</th>
                <td>{hours(totals.unresolved)}</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section aria-label="Stretches">
        <h2>Stretches</h2>
        <ol className="seg-list">
          {draft.map((segment, i) => (
            <SegmentEditor
              key={`${segment.startMin}-${i}`}
              segment={segment}
              index={i}
              isLast={i === draft.length - 1}
              selected={selected === i}
              onSelect={() => setSelected(i)}
              onStatus={(status) => setDraft((d) => setStatus(d, i, status))}
              onEnd={(minute) => setDraft((d) => moveBoundary(d, i, minute))}
              onSplit={() =>
                setDraft((d) => {
                  const s = d[i]!;
                  const mid = s.startMin + Math.max(1, Math.round((s.endMin - s.startMin) / 2 / 15) * 15);
                  return splitSegment(d, i, Math.min(mid, s.endMin - 1));
                })
              }
              onRemove={draft.length > 1 ? () => setDraft((d) => removeSegment(d, i)) : null}
            />
          ))}
        </ol>
      </section>

      {review.saved_rows.length > 0 && (
        <p className="paper-notice">
          This sheet is already in your log ({review.saved_rows.length} entr{review.saved_rows.length === 1 ? "y" : "ies"}).
          Saving again replaces them with what you see here.
        </p>
      )}

      {needsAck && (
        <section aria-label="Entries this would replace" className="paper-notice">
          <h2>Your log already has entries in this day</h2>
          <ul>
            {review.conflicts.map((c) => (
              <li key={c.id}>
                {STATUS_OPTIONS.find((o) => o.value === c.duty_status)?.label} from{" "}
                {formatDateTime(c.started_at, review.time_zone)}
              </li>
            ))}
          </ul>
          <label className="paper-ack">
            <input type="checkbox" checked={replaceAck} onChange={(e) => setReplaceAck(e.target.checked)} /> Replace
            these with the paper (they stay recoverable under Deleted)
          </label>
        </section>
      )}

      {!validation.ok && (
        <section aria-label="Before you can save" className="paper-notice">
          <h2>Before you can save</h2>
          <ul>
            {validation.errors.slice(0, 8).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </section>
      )}
      {!dateOk && <p role="alert">Enter the sheet&apos;s date.</p>}
      {saveError && <p role="alert">{saveError}</p>}

      <button type="button" className="paper-save" onClick={save} disabled={!canSave}>
        {saving ? "Saving…" : `Save ${logDate || "this day"} to my log`}
      </button>
      <p className="row-sub">
        Paper-log helper, not an ELD. The day is saved as recreated from your sheet; your paper (or the truck&apos;s
        ELD) stays the legal record. Last stretch: {last ? `${formatMinutes(last.startMin)}–24:00` : "—"}.
      </p>
    </div>
  );
}
