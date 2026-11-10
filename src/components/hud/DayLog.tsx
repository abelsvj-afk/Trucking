"use client";

// The day view on the Day log page (docs/design/driver-hud.md §3;
// UI/UX spec 2026-11-10 §2.2): one carrier day as the standard 24-hour
// grid, drawn from his duty rows, with totals per status. Step day by
// day or jump by date (tap the day title); tap a stretch or Fix to
// open the ONE editor sheet (DayEditPanel). Edited entries carry their
// annotation ("Edited <time> — '<reason>'") from the edit trail;
// tapping it - or the row's History button - opens the entry's Edit
// history. "Add a change I forgot" opens the same sheet in insert
// mode and works on empty days too. Today grows as the clock runs;
// edits anywhere refresh it through the live layer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DayGraph from "@/components/paper/DayGraph";
import Sheet from "@/components/Sheet";
import { apiClient } from "@/lib/api-client";
import { buildDayView, sortRows, type DayRow } from "@/lib/day-view";
import { addDays, zonedDate, zonedDayBounds } from "@/lib/zoned-day";
import { useNowTick } from "@/lib/use-now-tick";
import { formatMinutes } from "@/lib/paper-day";
import type { DraftSegment } from "@/lib/paper-day";
import type { DutyLog as DutyLogRow, DutyLogEdit, DutyStatus } from "@/types/entities";
import DayEditPanel from "./DayEditPanel";
import DutyEditHistory from "./DutyEditHistory";
import { HUD_STATUS_LABELS } from "./StatusSheet";

const hours = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
const ORDER: DutyStatus[] = ["off_duty", "sleeper", "driving", "on_duty"];

function clockIn(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(
    new Date(instantMs),
  );
}

export default function DayLog({
  rows,
  timeZone,
  oldestIso,
  focusEntryId,
}: {
  rows: DayRow[];
  timeZone: string;
  oldestIso: string;
  /** Deep link (?entry=<id>, spec §2.2/§2.4): select this entry BY ID and open its editor. */
  focusEntryId?: string;
}) {
  const nowMs = useNowTick(30_000);
  const today = zonedDate(nowMs, timeZone);
  const oldest = zonedDate(Date.parse(oldestIso), timeZone);
  const [picked, setPicked] = useState<string | null>(null);
  // The selection is the ENTRY (its id), never a list position: a live
  // update can reorder or add rows while a panel is open, and an edit
  // must only ever land on the entry the driver actually picked.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Which button opened the panel: Fix, or Delete (which goes straight to the confirmation).
  const [intent, setIntent] = useState<"edit" | "delete">("edit");
  const [insertOpen, setInsertOpen] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [appliedFocusId, setAppliedFocusId] = useState<string | null>(null);
  // Edit trail per entry, fetched lazily through GET /duty-logs/[id]
  // (the read path that returns the row PLUS its edits) - only for the
  // entries on the day being looked at, and for an entry whose history
  // is opened. This per-entry fetch is the lighter honest path: the
  // window/list reads stay untouched.
  const [editsById, setEditsById] = useState<Record<string, DutyLogEdit[]>>({});
  const editsRequestedRef = useRef<Set<string>>(new Set());
  const day = picked ?? today;

  const sorted = useMemo(() => sortRows(rows), [rows]);
  const { startMs, endMs } = zonedDayBounds(day, timeZone);
  const view = buildDayView(sorted, startMs, endMs, nowMs, timeZone);
  const segments: DraftSegment[] = view.stretches.map((s) => ({
    status: s.status,
    startMin: s.startMin,
    endMin: s.endMin,
    confidence: null,
    origin: "clean",
  }));
  const go = (date: string) => {
    setPicked(date === today ? null : date);
    setSelectedId(null);
    setMessage(null);
  };

  const fetchEdits = useCallback((id: string) => {
    if (editsRequestedRef.current.has(id)) return;
    editsRequestedRef.current.add(id);
    try {
      apiClient
        .get<DutyLogRow & { edits?: DutyLogEdit[] }>("duty-logs", id)
        .then((result) => setEditsById((prev) => ({ ...prev, [id]: result.edits ?? [] })))
        .catch(() => setEditsById((prev) => ({ ...prev, [id]: prev[id] ?? [] })));
    } catch {
      // A client without the read (older test doubles) reads as "no
      // trail fetched" - the annotation simply doesn't render.
      setEditsById((prev) => ({ ...prev, [id]: prev[id] ?? [] }));
    }
  }, []);

  // Annotations for the day on screen. Deferred like every other
  // set-state-in-effect in this codebase (the fetch's state lands in
  // promise callbacks regardless).
  const dayEntryIdsKey = view.stretches
    .map((s) => sorted[s.rowIndex]?.id)
    .filter(Boolean)
    .join(",");
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const id of dayEntryIdsKey.split(",").filter(Boolean)) fetchEdits(id);
    }, 0);
    return () => clearTimeout(timer);
  }, [dayEntryIdsKey, fetchEdits]);

  // History opened for an entry: make sure its trail is loaded.
  useEffect(() => {
    if (!historyId) return;
    const timer = setTimeout(() => fetchEdits(historyId), 0);
    return () => clearTimeout(timer);
  }, [historyId, fetchEdits]);

  // Deep link: resolve the entry BY ID (never by list position - the
  // spec inherits this component's own lesson), jump to its day, and
  // open its editor. Deferred state application, same discipline as
  // the Deleted toggle's ?view= read.
  useEffect(() => {
    if (!focusEntryId || focusEntryId === appliedFocusId) return;
    const target = sorted.find((r) => r.id === focusEntryId);
    if (!target) return;
    const timer = setTimeout(() => {
      setAppliedFocusId(focusEntryId);
      setPicked(zonedDate(Date.parse(target.started_at), timeZone));
      setIntent("edit");
      setSelectedId(focusEntryId);
      setMessage(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [focusEntryId, appliedFocusId, sorted, timeZone]);

  const selectedIndex = selectedId === null ? -1 : view.stretches.findIndex((s) => sorted[s.rowIndex]?.id === selectedId);
  const stretch = selectedIndex >= 0 ? view.stretches[selectedIndex] : undefined;
  // The picked entry no longer appears on this day (changed or deleted
  // elsewhere): close its panel and say so rather than edit something else.
  const vanished = selectedId !== null && !stretch && appliedFocusId !== selectedId;
  const historyRow = historyId ? sorted.find((r) => r.id === historyId) : undefined;

  return (
    <section aria-label="Day view" className="day-log">
      <div className="day-nav">
        <button type="button" onClick={() => go(addDays(day, -1))} disabled={day <= oldest} aria-label="Previous day">
          ‹
        </button>
        {showDatePicker ? (
          <input
            type="date"
            aria-label="Pick a day"
            value={day}
            min={oldest}
            max={today}
            onChange={(e) => {
              if (e.target.value) {
                go(e.target.value);
                setShowDatePicker(false);
              }
            }}
          />
        ) : (
          <button type="button" className="day-title-button" onClick={() => setShowDatePicker(true)} aria-label="Jump to a date">
            <h2>{day === today ? `Today · ${day}` : day}</h2>
          </button>
        )}
        <button type="button" onClick={() => go(addDays(day, 1))} disabled={day >= today} aria-label="Next day">
          ›
        </button>
      </div>
      {segments.length === 0 ? (
        <p className="hud-empty">Nothing logged on this day.</p>
      ) : (
        <DayGraph
          segments={segments}
          selected={selectedIndex >= 0 ? selectedIndex : null}
          onSelect={(i) => {
            setIntent("edit");
            setSelectedId(sorted[view.stretches[i]!.rowIndex]?.id ?? null);
          }}
        />
      )}
      {view.stretches.length > 0 && (
        <ul className="day-entries" aria-label="Entries on this day">
          {view.stretches.map((s, i) => {
            const row = sorted[s.rowIndex];
            if (!row) return null;
            const edits = editsById[row.id];
            const latest = edits && edits.length > 0 ? edits[edits.length - 1]! : null;
            return (
              <li key={`${row.id}-${i}`} className={row.id === selectedId ? "day-entry day-entry-selected" : "day-entry"}>
                <span className="day-entry-text">
                  <strong>{HUD_STATUS_LABELS[s.status]}</strong> {formatMinutes(s.startMin)}–{s.ongoing ? "now" : formatMinutes(s.endMin)}
                  {s.carriedIn ? " (started the day before)" : ""}
                  {latest && (
                    <button
                      type="button"
                      className="day-entry-edited"
                      onClick={() => setHistoryId(row.id)}
                      aria-label={`Edit history ${HUD_STATUS_LABELS[s.status]} ${formatMinutes(s.startMin)}`}
                    >
                      Edited {clockIn(Date.parse(latest.edited_at), timeZone)} — &lsquo;{latest.reason}&rsquo;
                    </button>
                  )}
                </span>
                <span className="day-entry-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setIntent("edit");
                      setSelectedId(row.id);
                      setMessage(null);
                    }}
                    aria-label={`Fix ${HUD_STATUS_LABELS[s.status]} ${formatMinutes(s.startMin)}`}
                  >
                    Fix
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryId(row.id)}
                    aria-label={`History ${HUD_STATUS_LABELS[s.status]} ${formatMinutes(s.startMin)}`}
                  >
                    History
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIntent("delete");
                      setSelectedId(row.id);
                      setMessage(null);
                    }}
                    aria-label={`Delete ${HUD_STATUS_LABELS[s.status]} ${formatMinutes(s.startMin)}`}
                  >
                    Delete
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        className="day-add-change"
        onClick={() => {
          setInsertOpen(true);
          setMessage(null);
        }}
      >
        ＋ Add a change I forgot
      </button>
      <ul className="day-totals">
        {ORDER.map((s) => (
          <li key={s}>
            <span>{HUD_STATUS_LABELS[s]}</span> <strong>{hours(view.totals[s])}</strong>
          </li>
        ))}
      </ul>
      <p className="row-sub">
        Times on your carrier&apos;s clock ({timeZone}). Tap a stretch on the graph, or use Fix / Delete on an entry below, to change it — a wrong time can always be moved or removed (deleted entries can be restored). Days before {oldest} are in the list
        below.
      </p>
      {vanished && (
        <p role="status" className="hud-note">
          That entry changed or was removed somewhere else, so its editor was closed. Tap a stretch to edit it again.
        </p>
      )}
      {message && (
        <p role="status" className="hud-note">
          {message}
        </p>
      )}
      {stretch && (
        <DayEditPanel
          key={`${selectedId}-${intent}-${sorted[stretch.rowIndex]!.started_at}-${sorted[stretch.rowIndex]!.duty_status}`}
          startWithDelete={intent === "delete"}
          rows={sorted}
          stretch={stretch}
          dayDate={day}
          timeZone={timeZone}
          nowMs={nowMs}
          edits={selectedId ? editsById[selectedId] : undefined}
          onDone={(m) => {
            setMessage(m);
            setSelectedId(null);
            if (selectedId) editsRequestedRef.current.delete(selectedId);
          }}
          onClose={() => setSelectedId(null)}
        />
      )}
      {insertOpen && (
        <DayEditPanel
          rows={sorted}
          stretch={null}
          dayDate={day}
          timeZone={timeZone}
          nowMs={nowMs}
          onDone={(m) => {
            setMessage(m);
            setInsertOpen(false);
          }}
          onClose={() => setInsertOpen(false)}
        />
      )}
      {historyId && historyRow && (
        <Sheet title="Edit history" onClose={() => setHistoryId(null)}>
          <DutyEditHistory row={historyRow} edits={editsById[historyId] ?? []} timeZone={timeZone} />
          <button
            type="button"
            onClick={() => {
              setHistoryId(null);
              setIntent("edit");
              setSelectedId(historyId);
              setMessage(null);
            }}
          >
            Fix this entry
          </button>
        </Sheet>
      )}
    </section>
  );
}
