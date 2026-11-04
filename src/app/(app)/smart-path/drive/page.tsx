"use client";

// Drive Mode D1 - the rolling surface (design Piece 2). Plan is
// where a run gets checked; Drive is where a checked run gets
// driven: position, follow camera, next stop, the closed spoken
// set. Drive never re-plans and never becomes a form.
//
// Foreground-honest by construction (G-5): the watch, the wake
// lock, and the checkpoint all live in this page; when the tab
// dies, the checkpoint (not a live track) is what survives. The
// truck/bird crossings never render here (see the crossing
// components) and while the truck is rolling the G-7 glance
// surface covers the app - "I'm parked" is the only door back.
//
// Glance type below is a Drive-local display style: the W4
// design-system glance token (audit D-2) hasn't landed, and the
// gate allows D1 a deliberate local exception, flagged here so it
// gets folded back into the system rather than drifting silently.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACTIVE_PLAN_STORAGE_KEY,
  DRIVE_CHECKPOINT_STORAGE_KEY,
  DRIVE_COPY,
  DRIVE_FIRST_RUN_STORAGE_KEY,
  DRIVE_SETTINGS,
  buildDrivePlan,
  driveGate,
  driveReviewLines,
  etaMinutesToStop,
  evaluateFix,
  goSummarySpeech,
  maneuverDirection,
  newDriveSession,
  nextManeuver,
  parseActivePlan,
  parseCheckpoint,
  projectClocks,
  serializeCheckpoint,
  skipNextStop,
  skipSpeech,
  speechForEvent,
  type DriveFix,
  type DrivePlanSnapshot,
  type DriveSession,
} from "@/lib/drive";
import { browserSpeaker, type Speaker } from "@/lib/drive-speech";
import { classifyMotion, isRestricted, settleMotion } from "@/lib/vehicle-motion";
import DriveGlance from "@/components/drive/DriveGlance";
import DriveClocks from "@/components/drive/DriveClocks";
import DriveStatusPrompt from "@/components/drive/DriveStatusPrompt";
import { easternHour, formatMinutes } from "@/lib/smart-path";
import { usePageTitle } from "@/lib/use-page-title";
import type { RouteCheckResponse } from "@/types/smart-path";

const DriveMap = dynamic(() => import("@/components/DriveMap"), { ssr: false });

const LAYOUT_STORAGE_KEY = "trucking.smartpath.drive-layout.v1";
const MPS_TO_MPH = 2.23694;

type Mode = "loading" | "preview" | "starting" | "rolling" | "parked";

interface WakeLockLike {
  release(): Promise<void>;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage full/blocked: Drive keeps working; the checkpoint
    // is a recovery nicety, never a reason to fail the surface.
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to do - see writeStorage.
  }
}

const MANEUVER_ARROWS = {
  left: "⬅",
  right: "➡",
  straight: "⬆",
  uturn: "↩",
  arrive: "⚑",
} as const;

export default function DrivePage() {
  usePageTitle("Drive");
  const [mode, setMode] = useState<Mode>("loading");
  const [plan, setPlan] = useState<DrivePlanSnapshot | null>(null);
  const [sourceResult, setSourceResult] = useState<RouteCheckResponse | null>(null);
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [firstRunSeen, setFirstRunSeen] = useState(true);
  const [layout, setLayout] = useState<"map" | "coach">("map");
  const [follow, setFollow] = useState(true);
  const [muted, setMuted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [, setRenderTick] = useState(0);
  // The clock render is allowed to read: set by the load effect,
  // the fix handler, and Start - never read from Date.now() in
  // render (this repo's purity lint, and honest "as of" labels).
  const [nowMs, setNowMs] = useState(0);

  const [finalReview, setFinalReview] = useState<string[]>([]);
  // Render reads the session from STATE; the watch callbacks and
  // checkpoint writer read the same object through sessionRef
  // (refs are not readable during render under this repo's lint).
  // syncSession is the one door that changes both.
  const [session, setSession] = useState<DriveSession | null>(null);

  const sessionRef = useRef<DriveSession | null>(null);
  const planRef = useRef<DrivePlanSnapshot | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const tickIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockLike | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const lastCheckpointWriteRef = useRef(0);
  const modeRef = useRef<Mode>("loading");
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const speaker = () => {
    if (!speakerRef.current) speakerRef.current = browserSpeaker();
    return speakerRef.current;
  };

  const syncSession = (next: DriveSession | null) => {
    sessionRef.current = next;
    setSession(next);
  };

  // ---- load the plan + any checkpoint, once -------------------------------
  useEffect(() => {
    let cancelled = false;
    // The reads hit an external system (localStorage) on mount;
    // state lands a microtask later, the React-endorsed shape for
    // mount-time external reads (and this repo's lint rule).
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      const now = Date.now();
      const checkpoint = parseCheckpoint(readStorage(DRIVE_CHECKPOINT_STORAGE_KEY), now);
      const stored = parseActivePlan(readStorage(ACTIVE_PLAN_STORAGE_KEY));
      if (stored) setSourceResult(stored.result);
      if (checkpoint) {
        planRef.current = checkpoint.plan;
        syncSession(checkpoint.session);
        setPlan(checkpoint.plan);
        setResumeAvailable(true);
      } else if (stored) {
        const built = buildDrivePlan(stored.result, new Date(stored.savedAtMs));
        planRef.current = built;
        setPlan(built);
      }
      setFirstRunSeen(readStorage(DRIVE_FIRST_RUN_STORAGE_KEY) === "1");
      setLayout(readStorage(LAYOUT_STORAGE_KEY) === "coach" ? "coach" : "map");
      setMuted(speaker().isMuted());
      setNowMs(now);
      setMode("preview");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const gate = useMemo(() => driveGate(plan), [plan]);

  // ---- checkpointing (G-5) --------------------------------------------------
  const writeCheckpoint = useCallback((force = false) => {
    const session = sessionRef.current;
    const currentPlan = planRef.current;
    if (!session || !currentPlan) return;
    const now = Date.now();
    if (!force && now - lastCheckpointWriteRef.current < 5_000) return;
    lastCheckpointWriteRef.current = now;
    writeStorage(DRIVE_CHECKPOINT_STORAGE_KEY, serializeCheckpoint(currentPlan, session, now));
  }, []);

  // ---- wake lock (G-5) -------------------------------------------------------
  const acquireWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request(type: "screen"): Promise<WakeLockLike> };
      };
      if (nav.wakeLock && !wakeLockRef.current) {
        wakeLockRef.current = await nav.wakeLock.request("screen");
      }
    } catch {
      // Denied or unsupported (Firefox): Drive works without it;
      // the first-run copy never promised it could force the
      // screen on, only that it asks.
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (lock) void lock.release().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") writeCheckpoint(true);
      if (document.visibilityState === "visible" && modeRef.current === "rolling") {
        void acquireWakeLock();
      }
    };
    const onPageHide = () => writeCheckpoint(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [writeCheckpoint, acquireWakeLock]);

  // ---- the watch --------------------------------------------------------------
  const handleFix = (fix: DriveFix | null, nowMsValue: number) => {
    const session = sessionRef.current;
    const currentPlan = planRef.current;
    if (!session || !currentPlan) return;
    const { events } = evaluateFix(session, currentPlan, fix, nowMsValue);
    for (const event of events) {
      if (event.type === "stopped-offer") continue; // rendered, not spoken
      const line = speechForEvent(event, currentPlan, session);
      if (line) speaker().speak(line);
    }
    writeCheckpoint();
    setNowMs(nowMsValue);
    setRenderTick((tick) => tick + 1);
  };

  const startWatching = () => {
    if (!("geolocation" in navigator)) {
      setPermissionDenied(true);
      setMode("preview");
      return;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        handleFix(
          {
            point: { lat: position.coords.latitude, lng: position.coords.longitude },
            accuracyM: position.coords.accuracy,
            speedMph:
              position.coords.speed !== null && position.coords.speed >= 0
                ? position.coords.speed * MPS_TO_MPH
                : null,
            headingDeg: position.coords.heading,
            atMs: position.timestamp || Date.now(),
          },
          Date.now(),
        );
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          stopWatching();
          setPermissionDenied(true);
          setMode("preview");
        }
        // Other errors (timeout, unavailable) are what the G-1
        // loss machinery is for - the tick keeps time.
      },
      { enableHighAccuracy: true, maximumAge: 2_000, timeout: 20_000 },
    );
    tickIdRef.current = setInterval(() => handleFix(null, Date.now()), 1_000);
  };

  const stopWatching = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (tickIdRef.current !== null) {
      clearInterval(tickIdRef.current);
      tickIdRef.current = null;
    }
    releaseWakeLock();
  };

  // Unmount cleanup goes through a latest-ref: returning the
  // callback itself from the effect defeated the compiler's
  // memoization check (and stopping the watch is unmount-only).
  const stopWatchingRef = useRef(stopWatching);
  useEffect(() => {
    stopWatchingRef.current = stopWatching;
  });
  useEffect(() => () => stopWatchingRef.current(), []);

  // ---- GO / parked / end -------------------------------------------------------
  const handleGo = () => {
    setPermissionDenied(false);
    setMode("starting");
  };

  const handleStartDrive = () => {
    const currentPlan = planRef.current;
    if (!currentPlan) return;
    // A session exists when resuming (checkpoint, or parked
    // mid-run) - only a genuinely new run gets a fresh session
    // and the spoken GO summary.
    const fresh = sessionRef.current === null;
    if (fresh) {
      syncSession(newDriveSession(currentPlan, Date.now()));
    }
    setEnded(false);
    setNowMs(Date.now());
    setFollow(true);
    writeStorage(DRIVE_FIRST_RUN_STORAGE_KEY, "1");
    setFirstRunSeen(true);
    void acquireWakeLock();
    startWatching();
    setMode("rolling");
    writeCheckpoint(true);
    if (fresh) {
      speaker().speak(goSummarySpeech(currentPlan));
    }
  };

  const handleParked = () => {
    stopWatching();
    speaker().stop();
    writeCheckpoint(true);
    setMode("parked");
  };

  const handleEndDrive = () => {
    stopWatching();
    speaker().stop();
    // The G-8 review is computed from stop outcomes BEFORE the
    // session goes away - ending the run is when he reads it.
    const currentPlan = planRef.current;
    const session = sessionRef.current;
    setFinalReview(
      currentPlan && session ? driveReviewLines(currentPlan, session) : [],
    );
    syncSession(null);
    setResumeAvailable(false);
    removeStorage(DRIVE_CHECKPOINT_STORAGE_KEY);
    setEnded(true);
    setMode("parked");
  };

  const handleDiscardCheckpoint = () => {
    syncSession(null);
    setResumeAvailable(false);
    removeStorage(DRIVE_CHECKPOINT_STORAGE_KEY);
    const stored = parseActivePlan(readStorage(ACTIVE_PLAN_STORAGE_KEY));
    if (stored) {
      const built = buildDrivePlan(stored.result, new Date(stored.savedAtMs));
      planRef.current = built;
      setPlan(built);
    }
    setRenderTick((tick) => tick + 1);
  };

  const handleSkip = () => {
    const session = sessionRef.current;
    const currentPlan = planRef.current;
    if (!session || !currentPlan) return;
    const skipped = currentPlan.stops[session.nextStopIndex];
    if (!skipped || session.stopStatus[session.nextStopIndex] !== "pending") return;
    skipNextStop(session, currentPlan);
    const next =
      session.nextStopIndex < currentPlan.stops.length
        ? currentPlan.stops[session.nextStopIndex]!
        : null;
    speaker().speak(skipSpeech(skipped, next));
    writeCheckpoint(true);
    setRenderTick((tick) => tick + 1);
  };

  const handleMuteToggle = () => {
    const next = !muted;
    speaker().setMuted(next);
    setMuted(next);
  };

  const handleLayout = (next: "map" | "coach") => {
    setLayout(next);
    writeStorage(LAYOUT_STORAGE_KEY, next);
  };

  // ---- derived render state (state only - refs are off-limits in render) --------
  const lastFix = session?.lastFix ?? null;
  const speedMph = lastFix?.speedMph ?? null;
  // Fail closed (lib/vehicle-motion.ts): the fuller screen needs a
  // POSITIVE "stopped" from a fresh fix. Moving, no speed, a stale fix -
  // all stay on the moving surface.
  // A stop must also have HELD for a few seconds (settleMotion) before the
  // fuller screen is allowed - a lull in traffic is not "parked".
  const nowForMotion = nowMs || lastFix?.atMs || 0;
  const motion = settleMotion(
    classifyMotion(speedMph, lastFix ? nowForMotion - lastFix.atMs : null),
    session?.stoppedSinceMs != null ? nowForMotion - session.stoppedSinceMs : null,
  );
  const rolling = mode === "rolling" && isRestricted(motion) && DRIVE_SETTINGS.rollingSurface === "glance";
  const nextStop =
    plan && session && session.nextStopIndex < plan.stops.length
      ? plan.stops[session.nextStopIndex]!
      : null;
  const projection = plan && session ? projectClocks(plan, session, nowMs || session.startedAtMs) : null;
  const upcoming = plan && session ? nextManeuver(plan, session.progressFraction) : null;
  const night = easternHour(new Date(nowMs)) >= 20 || easternHour(new Date(nowMs)) < 6;
  const positionQuality = !session?.lastFix
    ? null
    : session.gpsBannerOn
      ? "lost"
      : session.lastFix.accuracyM > 100
        ? "poor"
        : "good";

  const mapGeometry =
    sourceResult && plan && sourceResult.load.id === plan.loadId
      ? sourceResult.route.geometry
      : (plan?.geometry ?? []);
  const mapDeadhead =
    sourceResult && plan && sourceResult.load.id === plan.loadId
      ? (sourceResult.deadhead?.geometry ?? [])
      : [];

  if (mode === "loading") {
    return (
      <div>
        <h1>Drive</h1>
        <p>Loading your checked plan…</p>
      </div>
    );
  }

  if (!plan || !gate.ok) {
    return (
      <div>
        <h1>Drive</h1>
        <p style={{ fontSize: "1.25rem", fontWeight: 600 }}>
          {gate.ok ? DRIVE_COPY.noPlan : gate.copy}
        </p>
        <p>
          <Link href="/smart-path">Plan a run</Link>
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        background: night ? "#0b1220" : undefined,
        color: night ? "#e5e7eb" : undefined,
        minHeight: "100%",
        paddingBottom: "12px",
      }}
    >
      <h1>
        Drive — {plan.originLabel} → {plan.destinationLabel}
      </h1>

      {mode === "preview" && (
        <section aria-label="Drive preview">
          {resumeAvailable && session && (
            <div
              style={{
                border: "2px solid #2563eb",
                borderRadius: "12px",
                padding: "12px",
                marginBottom: "12px",
              }}
            >
              <p style={{ fontSize: "1.25rem", fontWeight: 700 }}>
                You were mid-run to {plan.destinationLabel}. Resume Drive?
              </p>
              <button
                type="button"
                onClick={handleGo}
                style={{ minHeight: "56px", padding: "0 24px", fontSize: "1.1rem", fontWeight: 700 }}
              >
                Resume Drive
              </button>{" "}
              <button type="button" onClick={handleDiscardCheckpoint} style={{ minHeight: "56px", padding: "0 16px" }}>
                Discard
              </button>
            </div>
          )}
          {permissionDenied && <p role="alert">{DRIVE_COPY.permissionDenied}</p>}
          <p>
            {Math.round(plan.totalMiles)} miles · planned arrival{" "}
            {plan.arrivalAt
              ? new Date(plan.arrivalAt).toLocaleString("en-US", { timeZone: "America/New_York" })
              : "—"}
          </p>
          <p>{DRIVE_COPY.coverageCaveat}</p>
          <p>{DRIVE_COPY.hoursSmallPrint}</p>
          <p>
            {plan.maneuvers.length > 0
              ? "Turn prompts are on for this run."
              : "This plan has no turn prompts — Drive will guide by next stop only."}
          </p>

          <h2>The day</h2>
          <ul>
            {plan.timeline.map((segment) => (
              <li key={`${segment.kind}-${segment.label}`}>
                {segment.label}: {formatMinutes(segment.minutes)}
              </li>
            ))}
          </ul>

          <h2>Stops</h2>
          <ol>
            {plan.stops.map((stop, i) => (
              <li key={stop.id}>
                <strong>{stop.badge}</strong> {stop.name}
                {session && session.stopStatus[i] !== "pending"
                  ? ` — ${session.stopStatus[i]}`
                  : ""}
              </li>
            ))}
          </ol>

          {DRIVE_SETTINGS.coachLayoutAvailable && (
            <fieldset>
              <legend>Layout</legend>
              <label>
                <input
                  type="radio"
                  name="drive-layout"
                  checked={layout === "map"}
                  onChange={() => handleLayout("map")}
                />{" "}
                Map leads
              </label>{" "}
              <label>
                <input
                  type="radio"
                  name="drive-layout"
                  checked={layout === "coach"}
                  onChange={() => handleLayout("coach")}
                />{" "}
                Coach — compact card, for running beside your ELD nav
              </label>
            </fieldset>
          )}

          {!resumeAvailable && (
            <button
              type="button"
              onClick={handleGo}
              style={{
                minHeight: "72px",
                padding: "0 32px",
                fontSize: "1.5rem",
                fontWeight: 800,
                borderRadius: "12px",
              }}
            >
              GO
            </button>
          )}
          <DriveClocks />
          <DriveStatusPrompt offer={["driving"]} />
        </section>
      )}

      {mode === "starting" && (
        <section aria-label="Before you roll">
          <p style={{ fontSize: "1.25rem", fontWeight: 600 }}>{DRIVE_COPY.permissionExplainer}</p>
          {!firstRunSeen && <p style={{ fontSize: "1.1rem" }}>{DRIVE_COPY.firstRun}</p>}
          <button
            type="button"
            onClick={handleStartDrive}
            style={{ minHeight: "72px", padding: "0 32px", fontSize: "1.25rem", fontWeight: 800 }}
          >
            Start Drive
          </button>{" "}
          <button type="button" onClick={() => setMode("preview")} style={{ minHeight: "72px", padding: "0 16px" }}>
            Not yet
          </button>
        </section>
      )}

      {(mode === "rolling" || mode === "parked") && session && (
        <>
          {session.gpsBannerOn && mode === "rolling" && (
            <p role="alert" style={{ fontWeight: 700 }}>
              {DRIVE_COPY.gpsLostBanner}
            </p>
          )}

          {mode === "rolling" && !rolling && (
            <section aria-label="Drive">
              <DriveMap
                geometry={mapGeometry}
                deadheadGeometry={mapDeadhead}
                stops={plan.stops}
                stopStatus={session.stopStatus}
                position={lastFix?.point ?? null}
                headingDeg={lastFix?.headingDeg ?? null}
                positionQuality={positionQuality}
                follow={follow}
                onUserPan={() => setFollow(false)}
                night={night}
                height={layout === "coach" ? "22vh" : "46vh"}
              />
              {!follow && (
                <button type="button" onClick={() => setFollow(true)} style={{ minHeight: "48px", padding: "0 16px" }}>
                  Re-center on me
                </button>
              )}
              {nextStop ? (
                <div>
                  <p style={{ fontSize: "1.8rem", fontWeight: 800 }}>
                    Next: {nextStop.name}
                  </p>
                  <p style={{ fontSize: "1.25rem" }}>
                    {Math.max(0, (nextStop.fraction - session.progressFraction) * plan.totalMiles).toFixed(1)} mi
                    {(() => {
                      const eta = etaMinutesToStop(plan, session, nextStop, lastFix);
                      return eta !== null ? ` · about ${Math.round(eta)} min` : "";
                    })()}
                    {nextStop.lifeBadge ? ` · ${nextStop.lifeBadge}` : ""}
                  </p>
                </div>
              ) : (
                <p style={{ fontSize: "1.5rem", fontWeight: 700 }}>That&apos;s the run — every stop is done.</p>
              )}
              {upcoming && (
                <p style={{ fontSize: "1.15rem" }}>
                  {MANEUVER_ARROWS[maneuverDirection(upcoming.maneuver.instruction)]}{" "}
                  {upcoming.maneuver.instruction} — {upcoming.milesAway.toFixed(1)} mi
                </p>
              )}
              <DriveClocks />
              {projection ? (
                <p>
                  Drive time left: {formatMinutes(Math.max(0, Math.round(projection.driveLeftMin)))} (projection
                  {projection.fromLogs ? "" : " — fresh clocks assumed, no logs yet"})
                </p>
              ) : (
                <p>No clocks ride with this plan — the drive-time chip needs a check made against your logs.</p>
              )}
              {lastFix && lastFix.accuracyM > 100 && (
                <p>GPS weak — ±{Math.round(lastFix.accuracyM)} m</p>
              )}
              <p>{DRIVE_COPY.hoursSmallPrint}</p>
              {session.stoppedOfferShown && (
                <p>
                  Looks like you&apos;re stopped — open the full plan?{" "}
                  <button type="button" onClick={handleParked} style={{ minHeight: "48px", padding: "0 16px" }}>
                    I&apos;m parked
                  </button>
                </p>
              )}
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button type="button" onClick={handleSkip} disabled={!nextStop} style={{ minHeight: "72px", padding: "0 20px", fontWeight: 700 }}>
                  Skip stop
                </button>
                <Link
                  href="/more/assistant"
                  style={{
                    minHeight: "72px",
                    padding: "0 20px",
                    fontWeight: 700,
                    display: "inline-flex",
                    alignItems: "center",
                    border: "1px solid currentColor",
                    borderRadius: "8px",
                  }}
                >
                  Talk to Abel
                </Link>
                <button type="button" onClick={handleParked} style={{ minHeight: "72px", padding: "0 20px", fontWeight: 700 }}>
                  I&apos;m parked
                </button>
                <button type="button" onClick={handleMuteToggle} style={{ minHeight: "72px", padding: "0 20px" }}>
                  {muted ? "Voice: off" : "Voice: on"}
                </button>
              </div>
            </section>
          )}

          {mode === "parked" && (
            <section aria-label="Parked">
              <h2>Parked</h2>
              <DriveClocks />
              <DriveStatusPrompt offer={["off_duty", "on_duty"]} />
              {(
                <>
                  <ol>
                    {plan.stops.map((stop, i) => (
                      <li key={stop.id}>
                        <strong>{stop.badge}</strong> {stop.name} — {session.stopStatus[i]}
                      </li>
                    ))}
                  </ol>
                  <h3>How the day went</h3>
                  {driveReviewLines(plan, session).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button type="button" onClick={handleStartDrive} style={{ minHeight: "56px", padding: "0 20px", fontWeight: 700 }}>
                      Keep driving
                    </button>
                    <Link
                      href="/smart-path"
                      style={{
                        minHeight: "56px",
                        padding: "0 20px",
                        display: "inline-flex",
                        alignItems: "center",
                        border: "1px solid currentColor",
                        borderRadius: "8px",
                      }}
                    >
                      Open the full plan
                    </Link>
                    <button type="button" onClick={handleEndDrive} style={{ minHeight: "56px", padding: "0 20px" }}>
                      End Drive
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {rolling && (
            <DriveGlance
              clocks={<DriveClocks dark />}
              map={
                <DriveMap
                  geometry={mapGeometry}
                  deadheadGeometry={mapDeadhead}
                  stops={plan.stops}
                  stopStatus={session.stopStatus}
                  position={lastFix?.point ?? null}
                  headingDeg={lastFix?.headingDeg ?? null}
                  positionQuality={positionQuality}
                  follow
                  onUserPan={() => {}}
                  night={night}
                  height="30vh"
                />
              }
              nextStop={
                nextStop
                  ? {
                      name: nextStop.name,
                      milesAway: Math.max(0, (nextStop.fraction - session.progressFraction) * plan.totalMiles),
                      badge: nextStop.lifeBadge ?? null,
                    }
                  : null
              }
              upcoming={
                upcoming
                  ? {
                      arrow: MANEUVER_ARROWS[maneuverDirection(upcoming.maneuver.instruction)],
                      instruction: upcoming.maneuver.instruction,
                      milesAway: upcoming.milesAway,
                    }
                  : null
              }
              driveLeftText={
                projection ? `Drive left ${formatMinutes(Math.max(0, Math.round(projection.driveLeftMin)))}` : null
              }
              gpsBanner={session.gpsBannerOn ? DRIVE_COPY.gpsLostBanner : null}
              speedUnknown={motion === "unknown"}
              onSkip={handleSkip}
              onParked={handleParked}
            />
          )}
        </>
      )}

      {mode === "parked" && ended && (
        <section aria-label="Run ended">
          <h2>Run ended</h2>
          <p>The run is closed and its checkpoint cleared.</p>
          <DriveStatusPrompt offer={["off_duty", "on_duty"]} />
          {finalReview.length > 0 && (
            <>
              <h3>How the day went</h3>
              {finalReview.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </>
          )}
          <p>
            <Link href="/smart-path">Back to the plan</Link> · <Link href="/">Home</Link>
          </p>
        </section>
      )}
    </div>
  );
}
