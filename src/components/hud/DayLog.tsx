"use client";

// The day view on Hours (docs/design/driver-hud.md §3): one carrier day
// as the standard 24-hour grid, drawn from his duty rows, with totals per
// status. Step day by day; tap a stretch to edit it. Today grows as the
// clock runs; edits anywhere refresh it through the live layer.

import { useMemo, useState } from "react";
import DayGraph from "@/components/paper/DayGraph";
import { buildDayView, sortRows, type DayRow } from "@/lib/day-view";
import { addDays, zonedDate, zonedDayBounds } from "@/lib/zoned-day";
import { useNowTick } from "@/lib/use-now-tick";
import { formatMinutes } from "@/lib/paper-day";
import type { DraftSegment } from "@/lib/paper-day";
import type { DutyStatus } from "@/types/entities";
import DayEditPanel from "./DayEditPanel";
import { HUD_STATUS_LABELS } from "./StatusSheet";

const hours = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
const ORDER: DutyStatus[] = ["off_duty", "sleeper", "driving", "on_duty"];

export default function DayLog({ rows, timeZone, oldestIso }: { rows: DayRow[]; timeZone: string; oldestIso: string }) {
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
  const selectedIndex = selectedId === null ? -1 : view.stretches.findIndex((s) => sorted[s.rowIndex]?.id === selectedId);
  const stretch = selectedIndex >= 0 ? view.stretches[selectedIndex] : undefined;
  // The picked entry no longer appears on this day (changed or deleted
  // elsewhere): close its panel and say so rather than edit something else.
  const vanished = selectedId !== null && !stretch;

  return (
    <section aria-label="Day view" className="day-log">
      <div className="day-nav">
        <button type="button" onClick={() => go(addDays(day, -1))} disabled={day <= oldest} aria-label="Previous day">
          ‹
        </button>
        <h2>{day === today ? `Today · ${day}` : day}</h2>
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
            return (
              <li key={`${row.id}-${i}`} className={row.id === selectedId ? "day-entry day-entry-selected" : "day-entry"}>
                <span className="day-entry-text">
                  <strong>{HUD_STATUS_LABELS[s.status]}</strong> {formatMinutes(s.startMin)}–{s.ongoing ? "now" : formatMinutes(s.endMin)}
                  {s.carriedIn ? " (started the day before)" : ""}
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
          onDone={(m) => {
            setMessage(m);
            setSelectedId(null);
          }}
          onClose={() => setSelectedId(null)}
        />
      )}
    </section>
  );
}
