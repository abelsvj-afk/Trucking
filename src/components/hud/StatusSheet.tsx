"use client";

// Duty-status change sheet (docs/design/driver-hud.md §2/§11). One
// tap on a status button opens this; one tap saves. Time defaults to
// now and can only go BACK (never the future). An entry whose time is
// well before the moment of saving is saved normally but labeled in
// words first - the server records when it was really entered, so a
// backdated log can never pass as live. Offline: queued on the device
// with its real start time, same as the full form.

import { useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { offlineOutbox } from "@/lib/offline-outbox";
import { localDateTimeInputValue } from "@/lib/time";
import { useNowTick } from "@/lib/use-now-tick";
import type { DutyLog, DutyStatus } from "@/types/entities";

export const HUD_STATUS_LABELS: Record<DutyStatus, string> = {
  off_duty: "Off duty",
  sleeper: "Sleeper berth",
  driving: "Driving",
  on_duty: "On duty (not driving)",
};

/** A start time more than this far before "now" is flagged as entered after the fact. */
export const AFTER_THE_FACT_MS = 5 * 60_000;

export function isAfterTheFact(startedAtMs: number, nowMs: number): boolean {
  return nowMs - startedAtMs > AFTER_THE_FACT_MS;
}

interface Props {
  /** The phone's latest GPS fix, if any: offers "Use my GPS position" (typed location stays the fallback). */
  gps?: { lat: number; lng: number; accuracyM: number; atMs: number } | null;
  status: DutyStatus;
  /**
   * Quick variant (Block A): the truck is moving or its motion is unknown. No typing at all - one big
   * button, time = now - because changing status must always be possible, and typing while rolling must
   * never be. Follows live motion: it switches back to the full form when the truck stops.
   */
  quick?: boolean;
  onCancel: () => void;
  onSaved: (queuedOffline: boolean) => void;
}

export default function StatusSheet({ status, gps = null, quick = false, onCancel, onSaved }: Props) {
  // Fresh id per opened sheet: one tap-and-save = one idempotent write.
  const [submissionId] = useState(() => crypto.randomUUID());
  const nowMs = useNowTick(1000);
  const [startedAt, setStartedAt] = useState(() => localDateTimeInputValue(new Date()));
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const startedMs = new Date(startedAt).getTime();
  const invalid = !Number.isFinite(startedMs);
  const inFuture = !invalid && startedMs > nowMs + 60_000;
  const afterTheFact = !invalid && !inFuture && isAfterTheFact(startedMs, nowMs);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Quick: always "now" (never a typed time) and no free text.
    if (!quick && (invalid || inFuture)) return;
    setError(null);
    setSaving(true);
    const body = {
      submission_id: submissionId,
      driver_id: null,
      load_id: null,
      duty_status: status,
      started_at: quick ? new Date().toISOString() : new Date(startedMs).toISOString(),
      location: quick ? null : location || null,
      odometer: null,
      notes: quick ? null : notes || null,
    };
    try {
      await apiClient.create<DutyLog>("duty-logs", body);
      onSaved(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        offlineOutbox.enqueue("duty-logs", body);
        onSaved(true);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="hud-sheet"
      data-motion-exempt
      onSubmit={handleSubmit}
      aria-label={`Change status to ${HUD_STATUS_LABELS[status]}`}
    >
      <h3>Change to: {HUD_STATUS_LABELS[status]}</h3>
      {quick && (
        <>
          <p className="hud-sheet-note">
            You&apos;re moving (or your speed isn&apos;t known), so this saves your status as of <strong>right now</strong> —
            no typing. You can add details later when you&apos;re parked.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="hud-sheet-actions">
            <button type="submit" className="hud-quick-btn" disabled={saving}>
              {saving ? "Saving…" : `Switch to ${HUD_STATUS_LABELS[status]} now`}
            </button>
            <button type="button" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
          </div>
        </>
      )}
      {!quick && (
      <>
      <label htmlFor="hud-started-at">Starts at (your local time)</label>
      <input
        id="hud-started-at"
        type="datetime-local"
        value={startedAt}
        max={localDateTimeInputValue(new Date(nowMs))}
        onChange={(event) => setStartedAt(event.target.value)}
        required
      />
      {inFuture && <p role="alert">A status can&apos;t start in the future. Pick now or earlier.</p>}
      {afterTheFact && (
        <p role="status" className="hud-sheet-note">
          This time is earlier than now, so it will be saved as <strong>entered after the fact</strong>.
          The real time you saved it is recorded too.
        </p>
      )}
      <label htmlFor="hud-location">Where (city, state, or mile marker)</label>
      <input id="hud-location" value={location} onChange={(event) => setLocation(event.target.value)} />
      {gps && nowMs - gps.atMs <= 60_000 && (
        <button
          type="button"
          onClick={() => setLocation(`GPS ${gps.lat.toFixed(4)}, ${gps.lng.toFixed(4)} (±${Math.round(gps.accuracyM)} m)`)}
        >
          Use my GPS position
        </button>
      )}
      <label htmlFor="hud-notes">Note (optional)</label>
      <input id="hud-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
      {error && <p role="alert">{error}</p>}
      <div className="hud-sheet-actions">
        <button type="submit" disabled={saving || invalid || inFuture}>
          {saving ? "Saving…" : "Save status"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
      </>
      )}
    </form>
  );
}
