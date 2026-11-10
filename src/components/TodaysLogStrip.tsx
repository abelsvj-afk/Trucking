"use client";

// Home "Today's log" strip (UI/UX Phase 4, spec §2.2/§2.4): today's
// duty entries as compact rows under the Duty HUD, fed by the SAME
// hosWindow Home already loaded (no new fetch). A row tap lands on
// /fleet/hos?entry=<id> with that entry's editor open in the Day log
// — 2 taps from Home to the open editor. An empty day offers the
// same door into the Day log, whose editor inserts into empty days.
// Loading and error states say so honestly; nothing is invented.

import Link from "next/link";
import Card from "@/components/Card";
import ListRow, { type ListRowDot } from "@/components/ListRow";
import { todaysLogEntries } from "@/lib/todays-log";
import type { HosWindowState } from "@/lib/use-hos-window";
import type { DutyLog } from "@/types/entities";

const STATUS_LABELS: Record<DutyLog["duty_status"], string> = {
  off_duty: "Off duty",
  sleeper: "Sleeper",
  driving: "Driving",
  on_duty: "On duty (not driving)",
};

const STATUS_DOT: Record<DutyLog["duty_status"], ListRowDot> = {
  off_duty: "muted",
  sleeper: "muted",
  driving: "bright",
  on_duty: "gold",
};

function formatTime(iso: string, timeZone: string): string {
  // Always an explicit zone (never the browser's): the carrier zone,
  // falling back to the owner's zone if a bad zone string ever lands.
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  }
}

export default function TodaysLogStrip({
  window,
  nowMs,
}: {
  window: HosWindowState;
  nowMs: number;
}) {
  return (
    <Card ariaLabel="Today's log" className="todays-log">
      <div className="todays-log-head">
        <h2>Today&apos;s log</h2>
        <Link href="/fleet/hos">Full day →</Link>
      </div>
      {window.status === "loading" && <p className="row-sub">Checking today&apos;s log…</p>}
      {window.status === "error" && (
        <p className="row-sub">
          Couldn&apos;t load today&apos;s log just now. <Link href="/fleet/hos">Open Day log</Link> to see
          where you stand.
        </p>
      )}
      {window.status === "loaded" &&
        (() => {
          const timeZone = window.hos.carrierTimeZone;
          const entries = todaysLogEntries(window.data, timeZone, nowMs);
          if (entries.length === 0) {
            return (
              <p className="row-sub">
                Nothing logged yet today.{" "}
                <Link href="/fleet/hos">Open Day log to add your first entry</Link> — it opens ready to
                log into today.
              </p>
            );
          }
          return (
            <ul className="todays-log-rows">
              {entries.map((entry) => (
                <li key={`${entry.id}-${entry.startIso}`}>
                  <Link href={`/fleet/hos?entry=${entry.id}`} className="todays-log-row">
                    <ListRow
                      title={STATUS_LABELS[entry.status]}
                      sub={`${formatTime(entry.startIso, timeZone)} – ${
                        entry.endIso ? formatTime(entry.endIso, timeZone) : "now"
                      }${entry.carriedIn ? " · carried in from yesterday" : ""}`}
                      dot={STATUS_DOT[entry.status]}
                      action={<span className="todays-log-fix">Fix</span>}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          );
        })()}
    </Card>
  );
}
