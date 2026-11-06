"use client";

// Edit one stretch of the day view (docs/design/driver-hud.md §3). Every
// change goes through the normal duty-log API (audited; deletes are soft
// and restorable under Deleted). Times are entered on the carrier's clock.
// A start time can't move past its neighbours or into the future, and a
// delete says plainly which status then runs on - no silent side effects.

import { useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { deleteConsequence, enteredAfterTheFact, startTimeBounds, type DayRow, type DayStretch } from "@/lib/day-view";
import { PAPER_REMARK_LINE, formatMinutes } from "@/lib/paper-day";
import { zonedDate, zonedInstant } from "@/lib/zoned-day";
import { formatDateTime } from "@/lib/time";
import type { DutyStatus } from "@/types/entities";
import { HUD_STATUS_LABELS } from "./StatusSheet";

const STATUSES: DutyStatus[] = ["off_duty", "sleeper", "driving", "on_duty"];

function clockIn(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(instantMs),
  );
}

interface Props {
  rows: DayRow[];
  stretch: DayStretch;
  dayDate: string;
  timeZone: string;
  nowMs: number;
  onDone: (message: string) => void;
  onClose: () => void;
  /** Opened from a list's Delete button: go straight to the "are you sure" step (still says what then runs on). */
  startWithDelete?: boolean;
}

export default function DayEditPanel({ rows, stretch, dayDate, timeZone, nowMs, onDone, onClose, startWithDelete = false }: Props) {
  const row = rows[stretch.rowIndex]!;
  const rowStartMs = Date.parse(row.started_at);
  const [status, setStatus] = useState<DutyStatus>(row.duty_status);
  const [startClock, setStartClock] = useState(() => clockIn(rowStartMs, timeZone));
  const mid = stretch.startMin + Math.floor((stretch.endMin - stretch.startMin) / 2);
  const [insertClock, setInsertClock] = useState(formatMinutes(Math.min(mid, 1439)));
  const [insertStatus, setInsertStatus] = useState<DutyStatus>(row.duty_status === "driving" ? "on_duty" : "driving");
  const [confirmDelete, setConfirmDelete] = useState(startWithDelete);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submissionId] = useState(() => crypto.randomUUID());

  const isPaper = row.source === "paper_photo";
  const label = HUD_STATUS_LABELS[row.duty_status];
  const consequence = deleteConsequence(rows, stretch.rowIndex);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone(message);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "No signal — nothing was changed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function saveStatus() {
    if (status === row.duty_status) return;
    void run(() => apiClient.update("duty-logs", row.id, { duty_status: status }), `Changed to ${HUD_STATUS_LABELS[status]}.`);
  }

  function saveStart() {
    const target = zonedInstant(zonedDate(rowStartMs, timeZone), startClock, timeZone).getTime();
    const { minMs, maxMs } = startTimeBounds(rows, stretch.rowIndex, nowMs);
    if (!Number.isFinite(target)) return setError("Enter a time.");
    if (target > maxMs) return setError("That would pass the next entry or go into the future. Pick an earlier time.");
    if (target < minMs) return setError("That would pass the previous entry. Pick a later time.");
    void run(
      () => apiClient.update("duty-logs", row.id, { started_at: new Date(target).toISOString() }),
      `Start moved to ${startClock}.`,
    );
  }

  function insertChange() {
    const target = zonedInstant(dayDate, insertClock, timeZone).getTime();
    // Stretch minutes are WALL-clock minutes (they read as clock times and
    // survive daylight-saving days), so bounds go back through the zone.
    const from = zonedInstant(dayDate, formatMinutes(stretch.startMin), timeZone).getTime();
    const to = zonedInstant(dayDate, formatMinutes(stretch.endMin), timeZone).getTime();
    if (!Number.isFinite(target) || target <= from || target >= to) {
      return setError(`Pick a time inside this stretch (${formatMinutes(stretch.startMin)}–${formatMinutes(stretch.endMin)}).`);
    }
    if (target > nowMs) return setError("A change can't be in the future.");
    void run(
      () =>
        apiClient.create("duty-logs", {
          submission_id: submissionId,
          driver_id: null,
          load_id: null,
          duty_status: insertStatus,
          started_at: new Date(target).toISOString(),
          location: null,
          odometer: null,
          notes: "Added from the day view.",
        }),
      `Added ${HUD_STATUS_LABELS[insertStatus]} at ${insertClock}.`,
    );
  }

  return (
    <section className="hud-sheet day-edit" aria-label={`Edit ${label} ${formatMinutes(stretch.startMin)} to ${formatMinutes(stretch.endMin)}`}>
      <h3>
        {label} {formatMinutes(stretch.startMin)}–{stretch.ongoing ? "now" : formatMinutes(stretch.endMin)}
      </h3>
      <p className="hud-note">
        {stretch.carriedIn ? `Started ${formatDateTime(row.started_at, timeZone)} (previous day). ` : ""}
        {isPaper ? "Recreated from a paper log sheet. " : ""}
        {enteredAfterTheFact(row) && row.created_at ? `Entered after the fact (saved ${formatDateTime(row.created_at, timeZone)}).` : ""}
      </p>
      {isPaper && <p className="hud-sheet-note">{PAPER_REMARK_LINE}</p>}

      <label htmlFor="day-status">Status</label>
      <select id="day-status" value={status} onChange={(e) => setStatus(e.target.value as DutyStatus)}>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {HUD_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <button type="button" onClick={saveStatus} disabled={busy || status === row.duty_status}>
        Save status
      </button>

      <label htmlFor="day-start">Started at ({timeZone})</label>
      <input id="day-start" type="time" value={startClock} onChange={(e) => setStartClock(e.target.value)} />
      <button type="button" onClick={saveStart} disabled={busy || startClock === clockIn(rowStartMs, timeZone)}>
        Move start
      </button>

      <fieldset className="day-insert">
        <legend>Add a change inside this stretch</legend>
        <label htmlFor="day-insert-time">At</label>
        <input id="day-insert-time" type="time" value={insertClock} onChange={(e) => setInsertClock(e.target.value)} />
        <label htmlFor="day-insert-status">Changed to</label>
        <select id="day-insert-status" value={insertStatus} onChange={(e) => setInsertStatus(e.target.value as DutyStatus)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {HUD_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <button type="button" onClick={insertChange} disabled={busy}>
          Add change
        </button>
      </fieldset>

      {!confirmDelete ? (
        <button type="button" className="day-delete" onClick={() => setConfirmDelete(true)} disabled={busy}>
          Delete this entry
        </button>
      ) : (
        <div role="alert" className="day-delete-confirm">
          <p>
            {consequence.previous
              ? `Deleting it makes ${HUD_STATUS_LABELS[consequence.previous].toLowerCase()} run on until ${
                  consequence.untilIso ? formatDateTime(consequence.untilIso, timeZone) : "now"
                }.`
              : "This is the first entry in your log — the time before the next entry will show as not logged."}{" "}
            You can restore it under Deleted.
          </p>
          <button
            type="button"
            onClick={() => void run(() => apiClient.remove("duty-logs", row.id), "Entry deleted — restore it under Deleted.")}
            disabled={busy}
          >
            Yes, delete it
          </button>
          <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy}>
            Keep it
          </button>
        </div>
      )}

      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={onClose} disabled={busy}>
        Close
      </button>
    </section>
  );
}
