"use client";

// The Home HUD (docs/design/driver-hud.md §2): current duty status,
// four live clock rings, four status buttons. Clocks tick locally each
// second from data fetched once (re-fetched on focus and every 5
// minutes as a safety net, and right after a save) - no per-second
// network; changes from anywhere (Telegram, another tab) arrive via
// the live layer. If there is nothing to count, it says so; it never runs a
// made-up clock. PAPER-LOG HELPER, NOT AN ELD - said on the surface.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { computeHudClocks, formatClock } from "@/lib/hud-clocks";
import Sheet from "@/components/Sheet";
import DayLog from "./DayLog";
import { useHosWindow } from "@/lib/use-hos-window";
import { useNowTick } from "@/lib/use-now-tick";
import { isProvisionalCarrierConfig } from "@/lib/hos-periods";
import { formatDateTime, formatSinceTime } from "@/lib/time";
import type { DutyStatus } from "@/types/entities";
import ClockRing from "./ClockRing";
import StatusSheet, { HUD_STATUS_LABELS } from "./StatusSheet";

const REFRESH_MS = 5 * 60_000;
const BUTTON_ORDER: DutyStatus[] = ["driving", "on_duty", "off_duty", "sleeper"];

export default function DutyHud() {
  const { state, retry, refresh } = useHosWindow();
  const nowMs = useNowTick();
  const [picked, setPicked] = useState<DutyStatus | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [dayOpen, setDayOpen] = useState(false);

  // Focus and data-change refreshes come from the live layer
  // (LiveDataProvider). This interval is only the safety net that
  // keeps the server's cycle total fresh across carrier-period
  // rollovers on a page left open for a long time.
  const refreshIfVisible = useCallback(() => {
    if (!document.hidden) refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(refreshIfVisible, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshIfVisible]);

  const loaded = state.status === "loaded" ? state : null;
  const clocks = loaded ? computeHudClocks(loaded.data, loaded.hos, nowMs) : null;
  const hos = loaded?.hos ?? null;
  const provisional = hos !== null && isProvisionalCarrierConfig(hos);

  return (
    <section aria-label="Duty status and clocks" className="hud">
      {state.status === "loading" && <p>Loading your clocks…</p>}
      {state.status === "error" && (
        <p role="alert">
          Couldn&apos;t load your clocks, so none are shown rather than risk a wrong one: {state.message}{" "}
          <button type="button" onClick={retry}>
            Retry
          </button>
        </p>
      )}

      {clocks?.state === "no-logs" && (
        <p className="hud-empty">Clocks start when you go on duty. Tap a status below to begin.</p>
      )}

      {clocks?.state === "ready" && (
        <>
          <p className="hud-status">
            <strong>{HUD_STATUS_LABELS[clocks.status]}</strong>{" "}
            <span className="hud-status-timer" aria-label="Time in this status">
              {formatClock(nowMs - clocks.statusSinceMs)}
            </span>
          </p>
          <p className="row-sub">
            since {formatSinceTime(new Date(clocks.statusSinceMs).toISOString(), nowMs)}
          </p>
          {clocks.rested && (
            <p className="hud-note">Rested 10+ hours — drive and window start counting when you go on duty.</p>
          )}
          <div className="hud-rings">
            {clocks.clocks.map((clock) => (
              <ClockRing key={clock.key} clock={clock} />
            ))}
          </div>
          {clocks.cycleUnavailable && (
            <p className="hud-note" role="status">
              The cycle clock isn&apos;t shown — it couldn&apos;t be computed.
            </p>
          )}
          {hos?.restartApplied && <p className="hud-note">Cycle restarted — 34 hours off ended {formatDateTime(hos.restartApplied.endedAt, hos.carrierTimeZone)}.</p>}
          {hos?.restartUnverified && (
            <p className="hud-note">A 34-hour restart couldn&apos;t be verified, so it is not counted.</p>
          )}
          {provisional && (
            <p className="hud-note">
              Cycle uses provisional carrier settings (70/8, 00:00, America/New_York) — set your carrier&apos;s
              real rules in Settings.
            </p>
          )}
        </>
      )}

      <div className="hud-buttons" role="group" aria-label="Change duty status">
        {BUTTON_ORDER.map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={picked === status}
            className={`hud-status-btn hud-btn-${status}`}
            onClick={() => {
              setSavedNote(null);
              setPicked(status);
            }}
          >
            {HUD_STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      {picked && (
        <Sheet title="Change status" onClose={() => setPicked(null)}>
          <StatusSheet
            key={picked}
            status={picked}
            onCancel={() => setPicked(null)}
            onSaved={(queued) => {
              setPicked(null);
              setSavedNote(
                queued
                  ? "No signal — saved on this device and will sync when you're back online."
                  : "Status saved.",
              );
              if (!queued) refresh();
            }}
          />
        </Sheet>
      )}

      <p className="hud-links">
        <button type="button" onClick={() => setDayOpen(true)} disabled={!loaded || loaded.data.length === 0}>
          Day log
        </button>
        <Link href="/fleet/hos/paper" className="hud-link-btn">
          Paper log
        </Link>
      </p>
      {dayOpen && loaded && (
        <Sheet title="Your day" onClose={() => setDayOpen(false)}>
          <DayLog rows={loaded.data} timeZone={loaded.hos.carrierTimeZone} oldestIso={loaded.hos.windowStart} />
        </Sheet>
      )}
      {savedNote && (
        <p role="status" className="hud-note">
          {savedNote}
        </p>
      )}

      <p className="hud-disclaimer">
        <strong>Paper-log helper, not an ELD.</strong> These numbers come from what you log here. The
        truck&apos;s ELD (or your official paper logs) is the legal record — if they ever disagree, the
        ELD/official log wins.
      </p>
    </section>
  );
}
