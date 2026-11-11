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
import { useMemo } from "react";
import { useNowTick } from "@/lib/use-now-tick";
import { useActiveRoute } from "@/lib/use-active-route";
import { useSpeedLimit } from "@/lib/use-speed-limit";
import { useServerPosition } from "@/lib/use-server-position";
import { routeProgress } from "@/lib/route-progress";
import { useActiveNavigation } from "@/lib/use-active-navigation";
import { etaAgainstClocks, formatMiles, liveGuidance } from "@/lib/active-navigation";
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
  driveLeftMs = null,
  windowLeftMs = null,
}: {
  position: VehiclePosition | null;
  headingDeg?: number | null;
  speedMph?: number | null;
  motion?: MotionState;
  /** The map is Home's main screen: taller, edge to edge, and it never silently vanishes. */
  hero?: boolean;
  /** His real remaining clocks from the one HOS read (display only): the ETA line compares against them. null = not known. */
  driveLeftMs?: number | null;
  windowLeftMs?: number | null;
}) {
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
  // ACTIVE-LOAD NAVIGATION: the automatic route to the active load's next stop (no Smart Path run needed). It feeds the SAME route-line
  // mechanism a Smart Path run uses (DriveMap's geometry / traveledGeometry); a saved Smart Path run is the fallback when there is none.
  const nav = useActiveNavigation(position ? { lat: position.lat, lng: position.lng, accuracyM: position.accuracyM } : null, headingDeg, speedMph);
  const smartPathRoute = useActiveRoute();
  const route = useMemo(
    () => (nav.route ? { geometry: nav.route.geometry, destinationLabel: nav.stopLabel ?? "your next stop" } : smartPathRoute),
    [nav.route, nav.stopLabel, smartPathRoute],
  );
  const guidance = useMemo(
    () => (nav.route && position ? liveGuidance(nav.route, { lat: position.lat, lng: position.lng }, nowMs, nav.guide) : null),
    [nav.route, nav.guide, position, nowMs],
  );
  const limit = useSpeedLimit(position, headingDeg, motion === "moving");
  const progress = useMemo(
    () => (position && route ? routeProgress({ lat: position.lat, lng: position.lng }, route.geometry) : null),
    [position, route],
  );
  if (!position) return hero ? <NoFixCard /> : null;
  const age = nowMs - position.atMs;
  if (!fromServer && age > POSITION_FRESH_MS) return hero ? <NoFixCard /> : null;

  const speedText = speedMph !== null && motion !== "stopped" ? String(Math.round(speedMph)) : motion === "stopped" ? "0" : "—";
  return (
    <section aria-label="Where you are" className={hero ? "home-position home-position-hero" : "home-position"}>
      <div className="home-map-wrap">
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
          traveledGeometry={guidance?.onRoute ? guidance.traveled : progress?.onRoute ? progress.traveled : []}
          onUserPan={() => {}}
          night={false}
          height={hero ? "clamp(220px, 50vh, 600px)" : "min(40vh, 340px)"}
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
      {nav.route && !nav.route.truckLegal && (
        <p role="alert" data-testid="not-truck-legal">
          <strong>NOT TRUCK-LEGAL.</strong> Only a car route could be reached, so it ignores height, weight and truck restrictions. It is drawn for
          reference only — turn-by-turn is off. Use the truck&apos;s own navigation.
        </p>
      )}
      {nav.route && guidance?.onRoute && guidance.next && (
        <p role="status" data-testid="nav-next">
          <strong>In {formatMiles(guidance.next.inMiles)}:</strong> {guidance.next.instruction}
        </p>
      )}
      {nav.route && guidance?.onRoute && guidance.etaAt !== null && guidance.milesLeft !== null && guidance.minutesLeft !== null && (() => {
        const line = etaAgainstClocks(guidance.etaAt, guidance.minutesLeft, { driveLeftMs, windowLeftMs });
        return (
          <p role={line.past ? "alert" : "status"} data-testid="nav-eta">
            {formatMiles(guidance.milesLeft)} to {nav.stopLabel ?? "your next stop"} · {line.text}
          </p>
        );
      })()}
      {/* One notice line. A not-truck-legal route's notice is the stamp above, so it is not repeated here. */}
      {nav.notice && (!nav.route || nav.route.truckLegal) && <p role="status" data-testid="nav-notice">{nav.notice}</p>}
      {!route && nav.unavailableReason && <p className="row-sub" role="note">{nav.unavailableReason}</p>}
      {nav.route && nav.guide && guidance?.onRoute && guidance.ahead.length > 1 && (
        <details>
          <summary>Turns ahead ({guidance.ahead.length})</summary>
          <ol>
            {guidance.ahead.slice(0, 40).map((m, i) => (
              <li key={`${i}-${m.instruction}`}>
                {formatMiles(m.inMiles)} — {m.instruction}
              </li>
            ))}
          </ol>
        </details>
      )}
      {nav.route && (
        <p className="row-sub">
          {nav.trailering ? "Trailer on this load — no U-turns; a reroute goes around the block." : "No trailer on this load (bobtail)."} Routed by{" "}
          {nav.route.providerName}.{nav.basis ? ` ${nav.basis}` : ""}
        </p>
      )}
      <p className="row-sub">
        {nav.route ? null : route ? (
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
    </section>
  );
}

/**
 * The map is Home's main screen, so when there is no fresh location it says WHY and how to fix it, instead of leaving a hole
 * (live audit 2026-11-07: the card simply was not there). Never a blank map or a guessed position.
 */
function NoFixCard() {
  return (
    <section aria-label="Where you are" className="home-position home-position-hero home-position-empty">
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
