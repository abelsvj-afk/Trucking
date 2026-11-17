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
import { buildSegments, summarizeDaySoFar } from "@/lib/hos";
import { startOfZonedDayMs } from "@/lib/zoned-day";
import { apiClient, ApiClientError } from "@/lib/api-client";
import Sheet from "@/components/Sheet";
import StoppedGate from "./StoppedGate";
import { useVehicleMotionDetail } from "@/lib/use-vehicle-motion";
import HomePositionCard from "./HomePositionCard";
import DayLog from "./DayLog";
import { useHosWindow } from "@/lib/use-hos-window";
import { useHomeMapCollapsed } from "@/lib/use-preferences";
import { useNowTick } from "@/lib/use-now-tick";
import { isProvisionalCarrierConfig } from "@/lib/hos-periods";
import { formatDateTime, formatSinceTime } from "@/lib/time";
import type { DutyStatus } from "@/types/entities";
import ClockRing from "./ClockRing";
import ClockExplainerSheet from "./ClockExplainerSheet";
import LockedNow from "./LockedNow";
import { activeLocks } from "@/lib/clock-locks";
import type { ClockKey } from "@/lib/hud-clocks";
import StatusSheet, { HUD_STATUS_LABELS } from "./StatusSheet";

const REFRESH_MS = 5 * 60_000;
const BUTTON_ORDER: DutyStatus[] = ["driving", "on_duty", "off_duty", "sleeper"];

/** "2h", "5h 30m" - plain words for the split offer and the reset sheet. */
function hmWords(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h > 0 ? `${h}h${rest ? ` ${rest}m` : ""}` : `${rest}m`;
}

export default function DutyHud() {
  const { state, retry, refresh } = useHosWindow();
  const nowMs = useNowTick();
  // Driving safety (docs/design/driver-hud.md §5): changing or editing
  // needs a positive "stopped"; unknown speed asks first, never assumes.
  const { state: motion, position, headingDeg, speedMph } = useVehicleMotionDetail();
  const [picked, setPicked] = useState<DutyStatus | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [dayOpen, setDayOpen] = useState(false);
  const [explain, setExplain] = useState<ClockKey | null>(null);
  // Manual clock reset (owner 2026-11-17): a button HE presses, never
  // automatic. The confirm sheet IS the one press that does it.
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState<string | null>(null);
  // Phase 4 map controls (spec §2.4): collapse is the owner's STORED
  // preference (person_preferences key home_map_collapsed) — while it
  // loads, the map renders EXPANDED (the live default), never
  // flash-collapsed. Full-screen is session-only, never persisted;
  // ESC exits it alongside the toggle.
  const mapPref = useHomeMapCollapsed();
  const mapCollapsed = mapPref.loaded && mapPref.collapsed;
  const [mapFullscreen, setMapFullscreen] = useState(false);
  useEffect(() => {
    if (!mapFullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMapFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mapFullscreen]);

  // Focus and data-change refreshes come from the live layer
  // (LiveDataProvider). This interval is only the safety net that
  // keeps the server's cycle total fresh across period
  // rollovers on a page left open for a long time.
  const refreshIfVisible = useCallback(() => {
    if (!document.hidden) refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(refreshIfVisible, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshIfVisible]);

  const loaded = state.status === "loaded" ? state : null;
  const tz = loaded?.hos.carrierTimeZone ?? "America/New_York";
  const clocks = loaded
    ? computeHudClocks(loaded.data, loaded.hos, nowMs, {
        resetDayStartMs: loaded.hos.resetDayStartMs ?? null,
        clockResetAtMs:
          loaded.hos.clockResetAt && Number.isFinite(Date.parse(loaded.hos.clockResetAt))
            ? Date.parse(loaded.hos.clockResetAt)
            : null,
      })
    : null;
  const hos = loaded?.hos ?? null;

  // The reset confirm sheet's projection (owner 2026-11-17): computed
  // client-side from the loaded rows, so he sees before he presses
  // what the reset counted from today and what the clocks read after.
  // resetDayStartMs here is the start of TODAY in his zone.
  const resetProjection =
    resetOpen && loaded && clocks?.state === "ready"
      ? (() => {
          const todayStartMs = startOfZonedDayMs(nowMs, tz);
          const daySoFar = summarizeDaySoFar(buildSegments(loaded.data, nowMs), todayStartMs, nowMs);
          const after = computeHudClocks(loaded.data, loaded.hos, nowMs, {
            resetDayStartMs: todayStartMs,
            clockResetAtMs: nowMs,
          });
          return { daySoFar, after };
        })()
      : null;

  const doReset = async () => {
    setResetBusy(true);
    setResetError(null);
    try {
      await apiClient.resetDutyLogClocks();
      setResetOpen(false);
      setResetDone("Clocks reset — re-derived from today's log. Your original log is unchanged.");
      refresh();
    } catch (err) {
      setResetError(
        err instanceof ApiClientError ? err.message : "Couldn't reset the clocks. Try again.",
      );
    } finally {
      setResetBusy(false);
    }
  };
  const provisional = hos !== null && isProvisionalCarrierConfig(hos);
  const drivingLocked = clocks?.state === "ready" && activeLocks(clocks.clocks).length > 0;

  return (
    <div className={mapFullscreen ? "home-hud-fullscreen" : undefined}>
      {/* MAP-FIRST HOME (owner ruling 2026-11-07): the map is the hero of Home; the duty status and the clocks sit directly under it,
          and the pay preview follows them (page.tsx), so hours and pay stay in view without scrolling past the map. */}
      <HomePositionCard
        position={position}
        headingDeg={headingDeg ?? null}
        speedMph={speedMph ?? null}
        motion={motion}
        hero
        collapsed={mapCollapsed}
        onToggleCollapsed={() => mapPref.setCollapsed(!mapCollapsed)}
        fullscreen={mapFullscreen}
        onToggleFullscreen={() => setMapFullscreen((v) => !v)}
        // Active-load navigation, display only: the map's ETA line compares against the clocks already computed here. No hours math is changed.
        driveLeftMs={clocks?.state === "ready" ? (clocks.clocks.find((c) => c.key === "drive")?.remainingMs ?? null) : null}
        windowLeftMs={clocks?.state === "ready" ? (clocks.clocks.find((c) => c.key === "window")?.remainingMs ?? null) : null}
      />

    <section aria-label="Duty status and clocks" className="hud">
      {motion === "moving" && (
        <p role="status" className="hud-note">
          Moving — editing is off until you stop. Changing your duty status is always available. Your clocks keep running.
        </p>
      )}
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
              <ClockRing key={clock.key} clock={clock} onExplain={setExplain} />
            ))}
          </div>
          <LockedNow clocks={clocks.clocks} />
          {clocks.splitOffer && (
            <div className="hud-split-offer" role="alert">
              <p>
                <strong>Split break available.</strong> Take {hmWords(clocks.splitOffer.neededRestMs)} in the
                sleeper now — your 14-hour window moves to{" "}
                {formatDateTime(new Date(clocks.splitOffer.windowMovesToMs).toISOString(), tz)}, and
                you&apos;d have {hmWords(clocks.splitOffer.driveLeftAfterMs)} of driving left after.
                That&apos;s a partial gain, not a fresh 11 hours.
              </p>
              <p>Planning only — your ELD&apos;s own split calculation is the legal one.</p>
            </div>
          )}
          {clocks.split && !clocks.splitOffer && (
            <p className="hud-note" role="status">
              {clocks.split} Planning only - your ELD&apos;s own split calculation is the legal one.
            </p>
          )}
          {clocks.clockResetAtMs != null && (
            <p className="hud-note" role="status">
              Clocks were reset by hand at {formatDateTime(new Date(clocks.clockResetAtMs).toISOString(), tz)} —
              re-derived from that day&apos;s log. Your original log is unchanged.
            </p>
          )}
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
              Cycle uses the default hours settings (70/8, 00:00, America/New_York) — pick your own
              cycle in Settings.
            </p>
          )}
        </>
      )}

      <div className="hud-buttons" role="group" aria-label="Change duty status" data-motion-exempt>
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
            {status === "driving" && drivingLocked && <span className="hud-btn-lock"> 🔒 not legal now</span>}
          </button>
        ))}
      </div>

      {/* Manual clock reset (owner 2026-11-17): NEVER automatic - this button, pressed by him, is the only
          way the clocks reset. The confirm sheet shows what today already holds and what the clocks read
          after, so he presses it knowing exactly what it does. */}
      <p className="hud-reset-row">
        <button
          type="button"
          className="hud-reset-btn"
          disabled={!loaded}
          onClick={() => {
            setResetError(null);
            setResetDone(null);
            setResetOpen(true);
          }}
        >
          Reset clocks
        </button>
      </p>
      {resetDone && (
        <p role="status" className="hud-note">
          {resetDone}
        </p>
      )}

      {resetOpen && loaded && (
        <Sheet title="Reset clocks" onClose={() => setResetOpen(false)}>
          <p>
            This re-derives your clocks from <strong>today&apos;s log</strong> — it does not give you a
            fresh day. What you already did today still counts.
          </p>
          {resetProjection && (
            <>
              <p>
                Today so far: {hmWords(resetProjection.daySoFar.drivenMs)} driving,{" "}
                {hmWords(resetProjection.daySoFar.onDutyMs)} on duty, {resetProjection.daySoFar.breakCount}{" "}
                break{resetProjection.daySoFar.breakCount === 1 ? "" : "s"} (
                {hmWords(resetProjection.daySoFar.breakTotalMs)} total).
              </p>
              {resetProjection.after.state === "ready" && (
                <p>
                  After the reset: Drive{" "}
                  {hmWords(resetProjection.after.clocks.find((c) => c.key === "drive")?.remainingMs ?? 0)}{" "}
                  left, 14-hour window{" "}
                  {hmWords(resetProjection.after.clocks.find((c) => c.key === "window")?.remainingMs ?? 0)}{" "}
                  left.
                </p>
              )}
            </>
          )}
          <p>
            Your weekly cycle is <strong>not</strong> reset — only 34 straight hours off resets the 60/70.
            Your original log stays recorded and the reset shows in its history.
          </p>
          <p>
            If the log entries themselves are wrong, this reset will not fix the clocks — fix those entries
            in the day log instead.
          </p>
          {resetError && (
            <p role="alert" className="hud-note">
              {resetError}
            </p>
          )}
          <div className="hud-sheet-actions">
            <button type="button" disabled={resetBusy} onClick={doReset}>
              {resetBusy ? "Resetting…" : "Reset clocks"}
            </button>
            <button type="button" disabled={resetBusy} onClick={() => setResetOpen(false)}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}

      {picked && (
        <Sheet title="Change status" onClose={() => setPicked(null)}>
          {/* Never gated on motion (Block A): changing status must always work. Quick (no typing) unless positively stopped. */}
          <StatusSheet
            key={picked}
            status={picked}
            gps={position}
            quick={motion !== "stopped"}
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

      {explain && <ClockExplainerSheet clockKey={explain} cycleLabel={hos?.cycle ?? null} onClose={() => setExplain(null)} />}

      <p className="hud-links">
        <button
          type="button"
          onClick={() => setDayOpen(true)}
          disabled={!loaded || loaded.data.length === 0 || motion === "moving"}
        >
          Day log
        </button>
        {motion === "moving" ? (
          <span className="hud-link-btn hud-link-disabled" aria-disabled="true">
            Paper log
          </span>
        ) : (
          <Link href="/fleet/hos/paper" className="hud-link-btn">
            Paper log
          </Link>
        )}
      </p>
      {dayOpen && loaded && (
        <Sheet title="Your day" onClose={() => setDayOpen(false)}>
          <StoppedGate motion={motion}>
            <DayLog rows={loaded.data} timeZone={loaded.hos.carrierTimeZone} oldestIso={loaded.hos.windowStart} />
          </StoppedGate>
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
    </div>
  );
}
