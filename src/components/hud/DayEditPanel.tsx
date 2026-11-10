"use client";

// THE one day-log editor (UI/UX spec 2026-11-10 §2.2; mockup
// UIUX-Mockup-DayLogEdit.html is the locked visual target). One Sheet,
// three modes:
//   - "Fix this entry": every field (status, started_at, location,
//     odometer, notes, load) in one form, one Save. The original is
//     shown at the top and never erased - the fix lands in the entry's
//     edit trail with its reason.
//   - "Add a change I forgot": a first-class insert at ANY time of ANY
//     day - inside a stretch, before the first entry, or on a totally
//     empty day (the sheet takes a date + time). This is the backfill
//     flow, named in his words; it POSTs a create carrying its reason.
//   - "Delete entry…": keeps the honest consequence copy (which status
//     then runs on) and sends its reason with the delete.
// Every mode requires a reason (ReasonField) - Save stays disabled
// without one, and the server refuses a reasonless correction anyway
// (422). Motion lock is unchanged: this sheet is the parked editor;
// while moving, editing stays off and status changes stay on (the
// DutyHud / MotionLock rule) - nothing here weakens that.

import { useEffect, useState } from "react";
import { apiClient, ApiClientError, MUTATION_EVENT } from "@/lib/api-client";
import { deleteConsequence, enteredAfterTheFact, startTimeBounds, type DayRow, type DayStretch } from "@/lib/day-view";
import { PAPER_REMARK_LINE, formatMinutes } from "@/lib/paper-day";
import { zonedDate, zonedInstant } from "@/lib/zoned-day";
import { formatDateTime } from "@/lib/time";
import { usePickerList } from "@/lib/use-picker-list";
import type { DutyLog, DutyLogEdit, DutyStatus, Load } from "@/types/entities";
import Sheet from "@/components/Sheet";
import Field from "@/components/Field";
import ReasonField from "@/components/ReasonField";
import SegmentedStatus from "@/components/SegmentedStatus";
import DutyEditHistory from "./DutyEditHistory";
import { HUD_STATUS_LABELS } from "./StatusSheet";

const STATUS_OPTIONS = [
  { value: "off_duty" as DutyStatus, label: "Off duty" },
  { value: "sleeper" as DutyStatus, label: "Sleeper" },
  { value: "driving" as DutyStatus, label: "Driving" },
  { value: "on_duty" as DutyStatus, label: "On duty" },
];

function clockIn(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(instantMs),
  );
}

/** A datetime-local value ("YYYY-MM-DDTHH:mm") on the CARRIER's clock for an instant. */
function zonedDateTimeInputValue(instantMs: number, timeZone: string): string {
  return `${zonedDate(instantMs, timeZone)}T${clockIn(instantMs, timeZone)}`;
}

/** Parse a datetime-local value back to an instant on the carrier's clock (NaN when incomplete). */
function parseZonedDateTime(value: string, timeZone: string): number {
  const [date, time] = value.split("T");
  if (!date || !time) return NaN;
  return zonedInstant(date, time.slice(0, 5), timeZone).getTime();
}

/**
 * DELETE with its reason in the body (spec §2.2). Kept local to this
 * editor on purpose: the generic apiClient.remove contract (no body)
 * stays unchanged for every other entity. Mirrors apiClient.request's
 * error shape and fires the same mutation event so the live layer
 * refreshes exactly as for any other write.
 */
async function removeDutyLogWithReason(id: string, reason: string): Promise<void> {
  const path = `/api/v1/duty-logs/${id}`;
  const res = await fetch(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edit_reason: reason, edit_source: "app" }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; fields?: { path: string; message: string }[] };
    } | null;
    throw new ApiClientError(
      res.status,
      body?.error?.code ?? "UNKNOWN_ERROR",
      body?.error?.message ?? "Something went wrong. Please try again.",
      body?.error?.fields,
    );
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MUTATION_EVENT, { detail: { path } }));
  }
}

interface Props {
  rows: DayRow[];
  /** The stretch being fixed; null opens the sheet in insert mode (empty day / add-a-change). */
  stretch: DayStretch | null;
  dayDate: string;
  timeZone: string;
  nowMs: number;
  onDone: (message: string) => void;
  onClose: () => void;
  /** Opened from a list's Delete button: go straight to the "are you sure" step (still says what then runs on). */
  startWithDelete?: boolean;
  /** The entry's trail when the caller already fetched it; the panel fetches it itself when omitted. */
  edits?: DutyLogEdit[];
}

export default function DayEditPanel({
  rows,
  stretch,
  dayDate,
  timeZone,
  nowMs,
  onDone,
  onClose,
  startWithDelete = false,
  edits: editsProp,
}: Props) {
  const row = stretch ? rows[stretch.rowIndex] : undefined;
  // The day rows are full duty_logs rows from the window read; DayRow
  // only types the fields the graph needs, so read the rest through
  // the full shape (absent fields read as empty, honestly).
  const full = row as (DayRow & Partial<DutyLog>) | undefined;
  const [mode, setMode] = useState<"fix" | "insert">(stretch ? "fix" : "insert");

  // --- Fix-this-entry state ---
  const rowStartMs = row ? Date.parse(row.started_at) : NaN;
  const [status, setStatus] = useState<DutyStatus>(row?.duty_status ?? "on_duty");
  const [startedAt, setStartedAt] = useState(() =>
    Number.isFinite(rowStartMs) ? zonedDateTimeInputValue(rowStartMs, timeZone) : "",
  );
  const [location, setLocation] = useState(full?.location ?? "");
  const [odometer, setOdometer] = useState(full?.odometer != null ? String(full.odometer) : "");
  const [notes, setNotes] = useState(full?.notes ?? "");
  const [loadId, setLoadId] = useState(full?.load_id ?? "");
  const [reason, setReason] = useState("");
  const [reasonValid, setReasonValid] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(startWithDelete);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteReasonValid, setDeleteReasonValid] = useState(false);

  // --- Add-a-change state ---
  const todayDate = zonedDate(nowMs, timeZone);
  const [insDate, setInsDate] = useState(dayDate);
  const [insTime, setInsTime] = useState(() => (dayDate === todayDate ? clockIn(nowMs, timeZone) : "12:00"));
  const [insStatus, setInsStatus] = useState<DutyStatus>("on_duty");
  const [insLocation, setInsLocation] = useState("");
  const [insOdometer, setInsOdometer] = useState("");
  const [insNotes, setInsNotes] = useState("");
  const [insLoadId, setInsLoadId] = useState("");
  const [insReason, setInsReason] = useState("");
  const [insReasonValid, setInsReasonValid] = useState(false);
  const [submissionId] = useState(() => crypto.randomUUID());

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedEdits, setFetchedEdits] = useState<DutyLogEdit[] | null>(null);
  const edits = editsProp ?? fetchedEdits ?? undefined;

  const loads = usePickerList<Load>("loads");

  // The editor's own history section: fetch the trail when the caller
  // didn't hand it over (the day view passes its cached copy).
  useEffect(() => {
    if (!row || editsProp !== undefined) return;
    let cancelled = false;
    apiClient
      .get<DutyLog & { edits?: DutyLogEdit[] }>("duty-logs", row.id)
      .then((result) => {
        if (!cancelled) setFetchedEdits(result.edits ?? []);
      })
      .catch(() => {
        if (!cancelled) setFetchedEdits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [row, editsProp]);

  const isPaper = row?.source === "paper_photo";
  const label = row ? HUD_STATUS_LABELS[row.duty_status] : "";
  const consequence = stretch && row ? deleteConsequence(rows, stretch.rowIndex) : null;

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

  /** The fix patch: only the fields that actually changed (plus the reason meta, added by the caller). */
  function buildFixPatch(): Record<string, unknown> | string {
    if (!row || !full) return "Nothing to fix.";
    const target = parseZonedDateTime(startedAt, timeZone);
    if (!Number.isFinite(target)) return "Enter a start time.";
    const patch: Record<string, unknown> = {};
    if (status !== row.duty_status) patch.duty_status = status;
    if (target !== rowStartMs) {
      const { minMs, maxMs } = startTimeBounds(rows, stretch!.rowIndex, nowMs);
      if (target > maxMs) return "That would pass the next entry or go into the future. Pick an earlier time.";
      if (target < minMs) return "That would pass the previous entry. Pick a later time.";
      patch.started_at = new Date(target).toISOString();
    }
    const nextLocation = location.trim() ? location : null;
    if (nextLocation !== (full.location ?? null)) patch.location = nextLocation;
    const nextOdometer = odometer.trim() ? Number(odometer) : null;
    if (nextOdometer !== (full.odometer ?? null)) patch.odometer = nextOdometer;
    const nextNotes = notes.trim() ? notes : null;
    if (nextNotes !== (full.notes ?? null)) patch.notes = nextNotes;
    const nextLoadId = loadId ? loadId : null;
    if (nextLoadId !== (full.load_id ?? null)) patch.load_id = nextLoadId;
    return patch;
  }

  function saveFix() {
    if (!row) return;
    const patch = buildFixPatch();
    if (typeof patch === "string") return setError(patch);
    if (Object.keys(patch).length === 0) return setError("Nothing changed yet — change a field, then save the fix.");
    void run(
      () =>
        apiClient.update("duty-logs", row.id, {
          ...patch,
          edit_reason: reason.trim(),
          edit_source: "app",
        }),
      "Entry fixed — the original is kept in its edit history.",
    );
  }

  function insertChange() {
    const target = zonedInstant(insDate, insTime, timeZone).getTime();
    if (!Number.isFinite(target)) return setError("Enter a date and time.");
    if (target > nowMs) return setError("A change can't be in the future.");
    void run(
      () =>
        apiClient.create("duty-logs", {
          submission_id: submissionId,
          driver_id: null,
          load_id: insLoadId || null,
          duty_status: insStatus,
          started_at: new Date(target).toISOString(),
          location: insLocation.trim() ? insLocation : null,
          odometer: insOdometer.trim() ? Number(insOdometer) : null,
          notes: insNotes.trim() ? insNotes : null,
          edit_reason: insReason.trim(),
          edit_source: "app",
        }),
      `Added ${HUD_STATUS_LABELS[insStatus]} at ${insTime} — saved with your reason.`,
    );
  }

  function confirmDeleteEntry() {
    if (!row) return;
    void run(
      () => removeDutyLogWithReason(row.id, deleteReason.trim()),
      "Entry deleted — restore it under Deleted.",
    );
  }

  const loadOptions = (value: string, onChange: (v: string) => void, id: string) => (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No load</option>
      {loads.map((load) => (
        <option key={load.id} value={load.id}>
          {load.origin} → {load.destination}
        </option>
      ))}
    </select>
  );

  const title = mode === "fix" && row ? "Fix this entry" : "Add a change I forgot";

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="day-edit">
        {row && (
          <div className="segmented-status day-edit-modes" role="group" aria-label="Editor mode">
            <button type="button" aria-pressed={mode === "fix"} onClick={() => setMode("fix")}>
              Fix this entry
            </button>
            <button type="button" aria-pressed={mode === "insert"} onClick={() => setMode("insert")}>
              Add a change I forgot
            </button>
          </div>
        )}

        {mode === "fix" && row && stretch && (
          <>
            <p className="sheet-original">
              Original:{" "}
              <b>
                {label} from {formatDateTime(row.started_at, timeZone)}
              </b>{" "}
              (logged {row.created_at ? formatDateTime(row.created_at, timeZone) : "—"}). Your fix is added below
              it — the original is never erased.
            </p>
            {isPaper && <p className="hud-sheet-note">{PAPER_REMARK_LINE}</p>}
            {enteredAfterTheFact(row) && (
              <p className="hud-note">This entry was entered after the fact.</p>
            )}

            <div className="day-edit-field">
              <span className="ds-field-label">Status</span>
              <SegmentedStatus
                options={STATUS_OPTIONS}
                value={status}
                onChange={setStatus}
                ariaLabel="Status"
                columns={4}
              />
            </div>
            <Field label={`Started at (${timeZone})`} htmlFor="day-edit-started">
              <input
                id="day-edit-started"
                type="datetime-local"
                value={startedAt}
                onChange={(e) => setStartedAt(e.target.value)}
              />
            </Field>
            <Field label="Location" htmlFor="day-edit-location">
              <input
                id="day-edit-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. Melbourne, FL"
              />
            </Field>
            <Field label="Odometer" htmlFor="day-edit-odometer">
              <input
                id="day-edit-odometer"
                type="number"
                min="0"
                value={odometer}
                onChange={(e) => setOdometer(e.target.value)}
              />
            </Field>
            <Field label="Notes" htmlFor="day-edit-notes">
              <input id="day-edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <Field label="Load" htmlFor="day-edit-load">
              {loadOptions(loadId, setLoadId, "day-edit-load")}
            </Field>

            <ReasonField
              id="day-edit-reason"
              value={reason}
              onChange={(value, valid) => {
                setReason(value);
                setReasonValid(valid);
              }}
            />
            <button type="button" className="sheet-save" onClick={saveFix} disabled={busy || !reasonValid}>
              Save fix
            </button>

            {!confirmDelete ? (
              <div className="day-edit-delrow">
                <button type="button" className="day-delete" onClick={() => setConfirmDelete(true)} disabled={busy}>
                  Delete entry…
                </button>
                <button type="button" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
              </div>
            ) : (
              <div role="alert" className="day-delete-confirm">
                <p>
                  {consequence?.previous
                    ? `Deleting it makes ${HUD_STATUS_LABELS[consequence.previous].toLowerCase()} run on until ${
                        consequence.untilIso ? formatDateTime(consequence.untilIso, timeZone) : "now"
                      }.`
                    : "This is the first entry in your log — the time before the next entry will show as not logged."}{" "}
                  You can restore it under Deleted.
                </p>
                <ReasonField
                  id="day-delete-reason"
                  label="Why are you deleting this? (required)"
                  value={deleteReason}
                  onChange={(value, valid) => {
                    setDeleteReason(value);
                    setDeleteReasonValid(valid);
                  }}
                />
                <button type="button" onClick={confirmDeleteEntry} disabled={busy || !deleteReasonValid}>
                  Yes, delete it
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  Keep it
                </button>
              </div>
            )}

            {edits !== undefined && (
              <section aria-label="Edit history" className="day-edit-history">
                <h3>Edit history</h3>
                <DutyEditHistory row={row} edits={edits} timeZone={timeZone} />
              </section>
            )}
          </>
        )}

        {mode === "insert" && (
          <>
            <p className="sheet-original">
              Add a status change you forgot to log — at any time of any day, even before the first entry or on an
              empty day. It is saved as a real entry, with your reason in its history.
            </p>
            <div className="day-edit-field">
              <span className="ds-field-label">Status</span>
              <SegmentedStatus
                options={STATUS_OPTIONS}
                value={insStatus}
                onChange={setInsStatus}
                ariaLabel="Status"
                columns={4}
              />
            </div>
            <Field label="Day" htmlFor="day-insert-date">
              <input id="day-insert-date" type="date" value={insDate} onChange={(e) => setInsDate(e.target.value)} />
            </Field>
            <Field label={`Time (${timeZone})`} htmlFor="day-insert-time">
              <input id="day-insert-time" type="time" value={insTime} onChange={(e) => setInsTime(e.target.value)} />
            </Field>
            <Field label="Location" htmlFor="day-insert-location">
              <input
                id="day-insert-location"
                value={insLocation}
                onChange={(e) => setInsLocation(e.target.value)}
                placeholder="e.g. Melbourne, FL"
              />
            </Field>
            <Field label="Odometer" htmlFor="day-insert-odometer">
              <input
                id="day-insert-odometer"
                type="number"
                min="0"
                value={insOdometer}
                onChange={(e) => setInsOdometer(e.target.value)}
              />
            </Field>
            <Field label="Notes" htmlFor="day-insert-notes">
              <input id="day-insert-notes" value={insNotes} onChange={(e) => setInsNotes(e.target.value)} />
            </Field>
            <Field label="Load" htmlFor="day-insert-load">
              {loadOptions(insLoadId, setInsLoadId, "day-insert-load")}
            </Field>
            <ReasonField
              id="day-insert-reason"
              value={insReason}
              onChange={(value, valid) => {
                setInsReason(value);
                setInsReasonValid(valid);
              }}
            />
            <button type="button" className="sheet-save" onClick={insertChange} disabled={busy || !insReasonValid}>
              Add entry
            </button>
            <div className="day-edit-delrow">
              <span />
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </div>
          </>
        )}

        {error && <p role="alert">{error}</p>}
        {stretch && (
          <p className="row-sub">
            {label} {formatMinutes(stretch.startMin)}–{stretch.ongoing ? "now" : formatMinutes(stretch.endMin)}
            {stretch.carriedIn ? " (started the day before)" : ""}
          </p>
        )}
      </div>
    </Sheet>
  );
}
