// Drive's rolling (map) screen - file decomposition of the Drive page,
// 2026-11-06. Markup and behavior unchanged; all state and handlers stay in
// the page and arrive as props.

import dynamic from "next/dynamic";
import Link from "next/link";
import DriveClocks from "./DriveClocks";
import {
  DRIVE_COPY,
  etaMinutesToStop,
  maneuverDirection,
  type DriveFix,
  type DrivePlanSnapshot,
  type DriveSession,
  type DriveStop,
  nextManeuver,
  projectClocks,
} from "@/lib/drive";
import { REROUTE_COPY } from "@/lib/drive-reroute";
import { formatMinutes } from "@/lib/smart-path";
import type { MapSegment } from "@/lib/smart-path-map-segments";
import type { DriveMapHazard } from "@/components/DriveMap";

const DriveMap = dynamic(() => import("@/components/DriveMap"), { ssr: false });

const MANEUVER_ARROWS = {
  left: "⬅",
  right: "➡",
  straight: "⬆",
  uturn: "↩",
  arrive: "⚑",
} as const;

type DriveMapProps = React.ComponentProps<typeof DriveMap>;

export default function DriveRolling({
  plan, session, lastFix, mapGeometry, mapDeadhead, positionQuality, follow, onFollow, night, layout,
  nextStop, upcoming, projection, routeNotice, muted, view3d, onView3dToggle, onReplan, onParked, onSkip, onMuteToggle,
  segments = [], hazards = [],
}: {
  plan: DrivePlanSnapshot;
  session: DriveSession;
  lastFix: DriveFix | null;
  mapGeometry: DriveMapProps["geometry"];
  mapDeadhead: DriveMapProps["deadheadGeometry"];
  positionQuality: DriveMapProps["positionQuality"];
  follow: boolean;
  onFollow: (next: boolean) => void;
  night: boolean;
  layout: "map" | "coach";
  nextStop: DriveStop | null | undefined;
  upcoming: ReturnType<typeof nextManeuver>;
  projection: ReturnType<typeof projectClocks> | null;
  routeNotice: string | null;
  muted: boolean;
  /** 3D driving view (owner 2026-11-17): tilted perspective, 3D truck at the bottom. */
  view3d: boolean;
  onView3dToggle: () => void;
  onReplan: () => void;
  onParked: () => void;
  onSkip: () => void;
  onMuteToggle: () => void;
  /** Live awareness: colored stretches (miles relative to the passed geometry). */
  segments?: MapSegment[];
  /** Live awareness: bridge / delay markers. */
  hazards?: DriveMapHazard[];
}) {
  return (
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
      onUserPan={() => onFollow(false)}
      night={night}
      height={layout === "coach" ? "22vh" : "46vh"}
      view3d={view3d}
      segments={segments}
      hazards={hazards}
    />
    {!follow && (
      <button type="button" onClick={() => onFollow(true)} style={{ minHeight: "48px", padding: "0 16px" }}>
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
    {routeNotice && (
      <p role="status" style={{ fontWeight: 700 }}>
        {routeNotice}
      </p>
    )}
    <button
      type="button"
      onClick={onReplan}
      disabled={!lastFix || routeNotice === REROUTE_COPY.working}
      style={{ minHeight: "56px", padding: "0 16px", fontWeight: 700 }}
    >
      Re-plan from here
    </button>
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
        <button type="button" onClick={onParked} style={{ minHeight: "48px", padding: "0 16px" }}>
          I&apos;m parked
        </button>
      </p>
    )}
    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
      <button type="button" onClick={onSkip} disabled={!nextStop} style={{ minHeight: "72px", padding: "0 20px", fontWeight: 700 }}>
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
      <button type="button" onClick={onParked} style={{ minHeight: "72px", padding: "0 20px", fontWeight: 700 }}>
        I&apos;m parked
      </button>
      <button type="button" onClick={onMuteToggle} style={{ minHeight: "72px", padding: "0 20px" }}>
        {muted ? "Voice: off" : "Voice: on"}
      </button>
      <button
        type="button"
        onClick={onView3dToggle}
        aria-pressed={view3d}
        style={{ minHeight: "72px", padding: "0 20px" }}
      >
        {view3d ? "3D map: on" : "3D map: off"}
      </button>
    </div>
  </section>
  );
}
