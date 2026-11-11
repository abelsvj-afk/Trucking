"use client";

// Live position on Home (docs/design/driver-hud.md §8; Block C of driver-hud-round2.md): an
// ELD-style mini map. Zoomed in, heading-up, the truck (a top-down semi icon) kept centred as it
// moves. When the active trip has a planned route it is drawn as a line with the part already
// driven dimmed; with no route it shows position + heading only - no invented line. A posted
// speed-limit badge appears ONLY when OpenStreetMap data has a limit for this road; no data, no
// badge. The current speed is always shown. Shown ONLY while a recent GPS fix exists - otherwise
// the card is absent (never a blank map or a guessed location). It is where the PHONE is, not an
// ELD engine position. Tiles are OpenStreetMap, as in Smart Path / Drive. The map is a glance
// surface: no touch pan/zoom, so it never traps page scroll.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState } from "react";
import Sheet from "@/components/Sheet";
import { useNowTick } from "@/lib/use-now-tick";
import { useActiveRoute } from "@/lib/use-active-route";
import { useSpeedLimit } from "@/lib/use-speed-limit";
import { useServerPosition } from "@/lib/use-server-position";
import { routeProgress } from "@/lib/route-progress";
import type { MotionState } from "@/lib/vehicle-motion";
import type { VehiclePosition } from "@/lib/use-vehicle-motion";
import SpeedLimitBadge from "./SpeedLimitBadge";

const DriveMap = dynamic(() => import("@/components/DriveMap"), { ssr: false });

/** A fix older than this is not "live": the card disappears rather than mislead. */
export const POSITION_FRESH_MS = 60_000;
/** Fix worse than this many metres is drawn as a poor (gray) marker. */
export const POOR_ACCURACY_M = 50;
export const FOLLOW_ZOOM = 15.5;

export function positionAgeText(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  return s < 5 ? "just now" : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

export default function HomePositionCard({
  position: devicePosition,
  headingDeg: deviceHeading = null,
  speedMph: deviceSpeed = null,
  motion: deviceMotion = "unknown",
  hero = false,
  collapsed = false,
  onToggleCollapsed,
  fullscreen = false,
  onToggleFullscreen,
}: {
  position: VehiclePosition | null;
  headingDeg?: number | null;
  speedMph?: number | null;
  motion?: MotionState;
  /** The map is Home's main screen: taller, edge to edge, and it never silently vanishes. */
  hero?: boolean;
  /**
   * Phase 4 map controls (spec §2.4, owner addendum 2026-11-10): the
   * collapse choice is the owner's stored preference, owned by
   * DutyHud; full-screen is session-only state, also owned there.
   * Collapsing hides the MAP BLOCK ONLY — the status/clocks/buttons
   * under it (DutyHud's own section) always stay visible.
   */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const [floatOpen, setFloatOpen] = useState(false);
  const handle = hero ? (
    <button
      type="button"
      className="home-map-handle"
      aria-expanded={!collapsed}
      onClick={onToggleCollapsed}
    >
      <span>Map — following your truck</span>
      <span className="home-map-handle-chev">{collapsed ? "⌃ Show map" : "⌄ Hide map"}</span>
    </button>
  ) : null;
  const floatSheet = floatOpen ? (
    <Sheet title="Floating window" onClose={() => setFloatOpen(false)}>
      <p>
        The floating window — your map plus your duty status, floating over other apps — lives in the{" "}
        <strong>Tracker app</strong>, not in this web page: a web page can&apos;t float over other apps.
        It appears while tracking is on, once the Tracker build that carries it is installed on your
        phone. Until that build is installed, there is no floating window — the full-screen button on
        the map gives you the big map right here in the app.
      </p>
      <button type="button" onClick={() => setFloatOpen(false)}>
        Got it
      </button>
    </Sheet>
  ) : null;

  // The map-surface controls (spec §2.4: ⤢ full-screen + Float sit ON
  // the map surface). They render in EVERY hero state — live map and
  // the no-fix off state alike (conformance fix D3: the off state used
  // to drop them, leaving only the handle + a route link). In the off
  // state full-screen enlarges the off-state card itself; Float opens
  // the same honest Tracker-handoff sheet as the live state.
  const mapControls = hero ? (
    <div className="home-map-ctl">
      <button
        type="button"
        aria-pressed={fullscreen}
        onClick={onToggleFullscreen}
      >
        <span aria-hidden="true">⤢</span> {fullscreen ? "Exit full screen" : "Full screen"}
      </button>
      <button type="button" onClick={() => setFloatOpen(true)}>
        <span aria-hidden="true">▣</span> Float
      </button>
    </div>
  ) : null;

  const nowMs = useNowTick(5_000);
  // This device's own fix wins. Without one (just reopened, GPS warming up, permission off) fall back to
  // the position Telegram Live Location last reported - labelled as Telegram's, with its age.
  const deviceFresh = devicePosition !== null && nowMs - devicePosition.atMs <= POSITION_FRESH_MS;
  const server = useServerPosition(!deviceFresh);
  const fromServer = !deviceFresh && server !== null;
  const position: VehiclePosition | null = deviceFresh ? devicePosition : server;
  const headingDeg = fromServer ? server.headingDeg : deviceHeading;
  const speedMph = fromServer ? server.speedMph : deviceSpeed;
  // Motion from a server fix is judged from its own speed, never assumed: unknown speed = unknown.
  const motion: MotionState = fromServer ? (server.speedMph === null ? "unknown" : server.speedMph >= 5 ? "moving" : "stopped") : deviceMotion;
  const route = useActiveRoute();
  const limit = useSpeedLimit(position, headingDeg, motion === "moving");
  const progress = useMemo(
    () => (position && route ? routeProgress({ lat: position.lat, lng: position.lng }, route.geometry) : null),
    [position, route],
  );
  // Collapsed (after every hook): the map block only — the handle
  // stays so the same control brings the map back.
  if (hero && collapsed) {
    return (
      <section aria-label="Where you are" className="home-position home-position-hero home-position-collapsed">
        {handle}
        {floatSheet}
      </section>
    );
  }
  if (!position)
    return hero ? (
      <>
        {handle}
        <NoFixCard controls={mapControls} fullscreen={fullscreen} />
        {floatSheet}
      </>
    ) : null;
  const age = nowMs - position.atMs;
  if (!fromServer && age > POSITION_FRESH_MS)
    return hero ? (
      <>
        {handle}
        <NoFixCard controls={mapControls} fullscreen={fullscreen} />
        {floatSheet}
      </>
    ) : null;

  const speedText = speedMph !== null && motion !== "stopped" ? String(Math.round(speedMph)) : motion === "stopped" ? "0" : "—";
  return (
    <section aria-label="Where you are" className={hero ? "home-position home-position-hero" : "home-position"}>
      {handle}
      <div className="home-map-wrap">
        {mapControls}
        <DriveMap
          geometry={route?.geometry ?? []}
          deadheadGeometry={[]}
          stops={[]}
          stopStatus={[]}
          position={{ lat: position.lat, lng: position.lng }}
          headingDeg={headingDeg}
          positionQuality={position.accuracyM > POOR_ACCURACY_M ? "poor" : "good"}
          follow
          headingUp
          followZoom={FOLLOW_ZOOM}
          interactive={false}
          frameRoute={false}
          traveledGeometry={progress?.onRoute ? progress.traveled : []}
          onUserPan={() => {}}
          night={false}
          height={hero ? (fullscreen ? "min(62vh, 720px)" : "clamp(220px, 50vh, 600px)") : "min(40vh, 340px)"}
          label={route ? "Map following your truck along your planned route" : "Map following your truck"}
        />
        <div className="home-map-overlay">
          <SpeedLimitBadge limitMph={limit} />
          <div className="home-speed" aria-label={speedText === "—" ? "Speed not available" : `Your speed ${speedText} miles per hour`}>
            <span className="home-speed-num">{speedText}</span>
            <span className="home-speed-unit">mph</span>
          </div>
        </div>
      </div>
      <p className="row-sub">
        {route ? (
          progress?.onRoute ? (
            <>
              On your route to {route.destinationLabel} · {Math.round(progress.milesLeft ?? 0)} mi to go ·{" "}
            </>
          ) : progress ? (
            <>Not on your planned route ({progress.offRouteMiles.toFixed(1)} mi away) · </>
          ) : null
        ) : (
          <>No route set — showing your position only · </>
        )}
        {fromServer ? "Last position from Telegram live location" : "Phone GPS"} · ±{Math.round(position.accuracyM)} m · {positionAgeText(age)} ·{" "}
        <Link href="/smart-path">{route ? "Route details" : "Plan a route"}</Link>
      </p>
      {floatSheet}
    </section>
  );
}

/**
 * The map is Home's main screen, so when there is no fresh location it says WHY and how to fix it, instead of leaving a hole
 * (live audit 2026-11-07: the card simply was not there). Never a blank map or a guessed position.
 */
function NoFixCard({
  controls,
  fullscreen = false,
}: {
  /** The map-surface controls (⤢ + Float) — the off state keeps them
   *  (spec §2.4; conformance fix D3). */
  controls?: React.ReactNode;
  /** Full-screen enlarges this card, same as it enlarges the map. */
  fullscreen?: boolean;
}) {
  return (
    <section
      aria-label="Where you are"
      className="home-position home-position-hero home-position-empty"
      style={fullscreen ? { minHeight: "min(62vh, 720px)" } : undefined}
    >
      {controls}
      <p role="status">
        <strong>Map off — no fresh location.</strong> Allow location for this site in your browser, or share Telegram Live Location with
        Abel, and your truck appears here. Your hours and pay below are not affected.
      </p>
      <p className="row-sub">
        <Link href="/smart-path">Plan a route</Link>
      </p>
    </section>
  );
}
