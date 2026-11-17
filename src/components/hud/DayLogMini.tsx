"use client";

// Home mini paper log (owner order 2026-11-17): today's duty grid in
// a small view directly under the hours, drawing the duty-status lines
// live from today's duty log so he can watch them draw as he drives.
// Reads the SAME hosWindow Home already loads (no new fetch) and the
// SAME buildDaySegments mapping the full Day log page uses - one source
// of truth, never a second copy. Tapping the widget opens the full Day
// log (/fleet/hos). Empty, loading and error states say so honestly;
// nothing is invented, and no line is drawn for time with no log.

import Link from "next/link";
import Card from "@/components/Card";
import DayGraph from "@/components/paper/DayGraph";
import { buildDaySegments } from "@/lib/day-view";
import { formatMinutes } from "@/lib/paper-day";
import { zonedDate, zonedDayBounds } from "@/lib/zoned-day";
import type { HosWindowState } from "@/lib/use-hos-window";
import { HUD_STATUS_LABELS } from "./StatusSheet";

export default function DayLogMini({
  window,
  nowMs,
}: {
  window: HosWindowState;
  nowMs: number;
}) {
  const head = (
    <div className="day-log-mini-head">
      <h2>Today&apos;s log</h2>
      <span>Full day →</span>
    </div>
  );

  return (
    <Card ariaLabel="Today's log" className="day-log-mini">
      {window.status === "loading" && (
        <>
          {head}
          <p className="row-sub">Checking today&apos;s log…</p>
        </>
      )}
      {window.status === "error" && (
        <>
          {head}
          <p className="row-sub">
            Couldn&apos;t load today&apos;s log just now. <Link href="/fleet/hos">Open Day log</Link> to see
            where you stand.
          </p>
        </>
      )}
      {window.status === "loaded" &&
        (() => {
          const timeZone = window.hos.carrierTimeZone;
          const today = zonedDate(nowMs, timeZone);
          const { startMs, endMs } = zonedDayBounds(today, timeZone);
          const { segments, ongoing } = buildDaySegments(window.data, startMs, endMs, nowMs, timeZone);
          if (segments.length === 0) {
            return (
              <>
                {head}
                <p className="row-sub">
                  Nothing logged yet today.{" "}
                  <Link href="/fleet/hos">Open Day log to add your first entry</Link> — it opens ready to
                  log into today.
                </p>
              </>
            );
          }
          return (
            <Link
              href="/fleet/hos"
              className="day-log-mini-link"
              aria-label="Today's log graph — open the full Day log"
            >
              {head}
              <DayGraph segments={segments} compact />
              <p className="row-sub">
                {ongoing ? `${HUD_STATUS_LABELS[ongoing.status]} since ${formatMinutes(ongoing.startMin)} · ` : ""}
                Times on your carrier&apos;s clock ({timeZone}).
              </p>
            </Link>
          );
        })()}
    </Card>
  );
}
