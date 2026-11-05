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
  serializeActivePlan,
} from "@/lib/drive";
import { browserSpeaker, type Speaker } from "@/lib/drive-speech";
import { classifyMotion, isRestricted, settleMotion } from "@/lib/vehicle-motion";
import { maneuverAnnouncement } from "@/lib/drive-maneuver-speech";
import {
  INITIAL_OFF_ROUTE,
  REROUTE_COPY,
  buildRerouteRequest,
  distanceToRouteMiles,
  evaluateRerouteResult,
  mayRequestReroute,
  reroutedSpeech,
  stepOffRoute,
  type OffRouteState,
} from "@/lib/drive-reroute";
import DriveGlance from "@/components/drive/DriveGlance";
import DriveClocks from "@/components/drive/DriveClocks";
import DriveRolling from "@/components/drive/DriveRolling";
import DrivePreview from "@/components/drive/DrivePreview";
import DriveParked from "@/components/drive/DriveParked";
import DriveRunEnded from "@/components/drive/DriveRunEnded";
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

/** No fix of the page's own for this long -> try Telegram Live Location's. */
const OWN_FIX_STALE_MS = 20_000;
/** A Telegram fix older than this is not "where he is now". */
const TELEGRAM_FIX_MAX_AGE_MS = 45_000;
const FALLBACK_POLL_MS = 10_000;

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
  const lastOwnFixMsRef = useRef(0);
  const fallbackIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const planRef = useRef<DrivePlanSnapshot | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const tickIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockLike | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  // Maneuver announcements already made this run (so none repeats).
  const spokenManeuversRef = useRef<Set<string>>(new Set());
  // Rerouting (audit D4): off-route episode, pacing, and the one in-flight request.
  const offRouteRef = useRef<OffRouteState>(INITIAL_OFF_ROUTE);
  const lastRerouteRef = useRef<number | null>(null);
  const rerouteBusyRef = useRef(false);
  const [routeNotice, setRouteNotice] = useState<string | null>(null);
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
    // Spoken turn instructions (audit D5): once about half a mile out and
    // once close in, per maneuver - never repeated.
    const announcement = maneuverAnnouncement(nextManeuver(currentPlan, session.progressFraction), spokenManeuversRef.current);
    if (announcement) {
      for (const key of announcement.keys) spokenManeuversRef.current.add(key);
      speaker().speak(announcement.line);
    }
    // Off the planned line? (distance, sustained, good fix only) -> say so
    // once, then ask for a truck-checked route from here, at most every 2 min.
    if (fix) {
      const step = stepOffRoute(offRouteRef.current, {
        distanceMiles: distanceToRouteMiles(fix.point, currentPlan.geometry),
        accuracyM: fix.accuracyM,
        nowMs: nowMsValue,
      });
      offRouteRef.current = step.state;
      if (step.justDetected) {
        speaker().speak(REROUTE_COPY.offRoute);
        setRouteNotice(REROUTE_COPY.offRoute);
      }
      if (step.offRoute && !rerouteBusyRef.current && mayRequestReroute(lastRerouteRef.current, nowMsValue)) {
        void requestReroute(fix.point, currentPlan);
      }
    }
    writeCheckpoint();
    setNowMs(nowMsValue);
    setRenderTick((tick) => tick + 1);
  };

  // A new route from where he is - accepted ONLY if the provider says it is
  // truck-checked (lib/drive-reroute.ts). A car route never replaces the
  // plan: the old one stays and he is told plainly.
  const requestReroute = async (point: { lat: number; lng: number }, currentPlan: DrivePlanSnapshot) => {
    rerouteBusyRef.current = true;
    lastRerouteRef.current = Date.now();
    setRouteNotice(REROUTE_COPY.working);
    try {
      const res = await fetch("/api/v1/smart-path/route-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRerouteRequest(currentPlan, point, new Date().toISOString())),
      });
      const body = res.ok ? ((await res.json()) as RouteCheckResponse) : null;
      const outcome = evaluateRerouteResult(body, new Date());
      if (!outcome.ok) {
        const text = outcome.reason === "car-route" ? REROUTE_COPY.failedCar : REROUTE_COPY.failedNoRoute;
        setRouteNotice(text);
        speaker().speak(text);
        return;
      }
      if (!sessionRef.current) return; // the run ended while we were asking
      const now = Date.now();
      writeStorage(ACTIVE_PLAN_STORAGE_KEY, serializeActivePlan(body!, now));
      setSourceResult(body!);
      planRef.current = outcome.plan;
      setPlan(outcome.plan);
      syncSession(newDriveSession(outcome.plan, now));
      spokenManeuversRef.current = new Set();
      offRouteRef.current = INITIAL_OFF_ROUTE;
      setRouteNotice("Rerouted — new truck-checked route.");
      speaker().speak(reroutedSpeech(outcome.milesToGo));
      writeCheckpoint();
      setRenderTick((tick) => tick + 1);
    } catch {
      setRouteNotice(REROUTE_COPY.failedNoRoute);
      speaker().speak(REROUTE_COPY.failedNoRoute);
    } finally {
      rerouteBusyRef.current = false;
    }
  };

  const startWatching = () => {
    if (!("geolocation" in navigator)) {
      setPermissionDenied(true);
      setMode("preview");
      return;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        lastOwnFixMsRef.current = Date.now();
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
    // Background fallback: when this page has had no fix of its own for a
    // while (screen off / tab frozen), take Telegram Live Location's latest
    // fix - only if it is itself fresh. Never invents a position.
    fallbackIdRef.current = setInterval(() => {
      if (Date.now() - lastOwnFixMsRef.current < OWN_FIX_STALE_MS) return;
      void fetch("/api/v1/position", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { position?: { lat: number; lng: number; accuracyM: number | null; headingDeg: number | null; speedMph: number | null; ageSeconds: number } | null } | null) => {
          const p = body?.position;
          if (!p || p.ageSeconds * 1000 > TELEGRAM_FIX_MAX_AGE_MS) return;
          const now = Date.now();
          handleFix(
            { point: { lat: p.lat, lng: p.lng }, accuracyM: p.accuracyM ?? 50, speedMph: p.speedMph, headingDeg: p.headingDeg, atMs: now - p.ageSeconds * 1000 },
            now,
          );
        })
        .catch(() => {});
    }, FALLBACK_POLL_MS);
  };

  const stopWatching = () => {
    if (fallbackIdRef.current !== null) {
      clearInterval(fallbackIdRef.current);
      fallbackIdRef.current = null;
    }
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
      spokenManeuversRef.current = new Set();
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
        <DrivePreview
          plan={plan}
          session={session}
          resumeAvailable={resumeAvailable}
          permissionDenied={permissionDenied}
          layout={layout}
          onGo={handleGo}
          onDiscard={handleDiscardCheckpoint}
          onLayout={handleLayout}
        />
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
            <DriveRolling
              plan={plan}
              session={session}
              lastFix={lastFix}
              mapGeometry={mapGeometry}
              mapDeadhead={mapDeadhead}
              positionQuality={positionQuality}
              follow={follow}
              onFollow={setFollow}
              night={night}
              layout={layout}
              nextStop={nextStop}
              upcoming={upcoming}
              projection={projection}
              routeNotice={routeNotice}
              muted={muted}
              onReplan={() => lastFix && void requestReroute(lastFix.point, plan)}
              onParked={handleParked}
              onSkip={handleSkip}
              onMuteToggle={handleMuteToggle}
            />
          )}

          {mode === "parked" && (
            <DriveParked plan={plan} session={session} onStart={handleStartDrive} onEnd={handleEndDrive} />
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
              routeNotice={routeNotice}
              speedUnknown={motion === "unknown"}
              onSkip={handleSkip}
              onParked={handleParked}
            />
          )}
        </>
      )}

      {mode === "parked" && ended && (
        <DriveRunEnded plan={plan} finalReview={finalReview} />
      )}
    </div>
  );
}
