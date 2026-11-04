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
  status: DutyStatus;
  onCancel: () => void;
  onSaved: (queuedOffline: boolean) => void;
}

export default function StatusSheet({ status, onCancel, onSaved }: Props) {
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
    if (invalid || inFuture) return;
    setError(null);
    setSaving(true);
    const body = {
      submission_id: submissionId,
      driver_id: null,
      load_id: null,
      duty_status: status,
      started_at: new Date(startedMs).toISOString(),
      location: location || null,
      odometer: null,
      notes: notes || null,
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
    <form className="hud-sheet" onSubmit={handleSubmit} aria-label={`Change status to ${HUD_STATUS_LABELS[status]}`}>
      <h3>Change to: {HUD_STATUS_LABELS[status]}</h3>
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
    </form>
  );
}
