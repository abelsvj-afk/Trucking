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
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const day = picked ?? today;

  const sorted = useMemo(() => sortRows(rows), [rows]);
  const { startMs, endMs } = zonedDayBounds(day, timeZone);
  const view = buildDayView(sorted, startMs, endMs, nowMs);
  const segments: DraftSegment[] = view.stretches.map((s) => ({
    status: s.status,
    startMin: s.startMin,
    endMin: s.endMin,
    confidence: null,
    origin: "clean",
  }));
  const go = (date: string) => {
    setPicked(date === today ? null : date);
    setSelected(null);
    setMessage(null);
  };
  const stretch = selected !== null ? view.stretches[selected] : undefined;

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
        <DayGraph segments={segments} selected={selected} onSelect={(i) => setSelected(i)} />
      )}
      <ul className="day-totals">
        {ORDER.map((s) => (
          <li key={s}>
            <span>{HUD_STATUS_LABELS[s]}</span> <strong>{hours(view.totals[s])}</strong>
          </li>
        ))}
      </ul>
      <p className="row-sub">
        Times on your carrier&apos;s clock ({timeZone}). Tap a stretch to change it. Days before {oldest} are in the list
        below.
      </p>
      {message && (
        <p role="status" className="hud-note">
          {message}
        </p>
      )}
      {stretch && (
        <DayEditPanel
          key={`${day}-${stretch.rowIndex}-${stretch.startMin}`}
          rows={sorted}
          stretch={stretch}
          dayDate={day}
          dayStartMs={startMs}
          timeZone={timeZone}
          nowMs={nowMs}
          onDone={(m) => {
            setMessage(m);
            setSelected(null);
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
