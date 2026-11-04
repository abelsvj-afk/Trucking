"use client";

// The moving surface of Drive Mode (docs/design/driver-hud.md §5;
// Smart Path design G-7). Shown whenever the vehicle is NOT positively
// stopped - moving, no speed reading, a stale reading. It keeps the live
// map and the next stop / maneuver big, and offers exactly two controls:
// Skip stop and "I'm parked". "I'm parked" is the only way back to the
// fuller screen: no links to other pages, no forms, nothing to read in
// small print. The map is passive (it follows the truck); it is never
// removed just because the truck is moving.

import type { ReactNode } from "react";

export interface GlanceStop {
  name: string;
  milesAway: number;
  badge: string | null;
}

export interface GlanceManeuver {
  arrow: string;
  instruction: string;
  milesAway: number;
}

interface Props {
  map: ReactNode;
  nextStop: GlanceStop | null;
  upcoming: GlanceManeuver | null;
  driveLeftText: string | null;
  gpsBanner: string | null;
  /** The reading behind this screen is missing/stale - said in words, never silently. */
  speedUnknown: boolean;
  onSkip: () => void;
  onParked: () => void;
}

export default function DriveGlance({
  map,
  nextStop,
  upcoming,
  driveLeftText,
  gpsBanner,
  speedUnknown,
  onSkip,
  onParked,
}: Props) {
  return (
    <div
      role="region"
      aria-label="Driving"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "#0b1220",
        color: "#f9fafb",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "12px 16px 20px",
        gap: "8px",
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {gpsBanner && (
          <p role="alert" style={{ fontWeight: 700, fontSize: "1.1rem", margin: 0 }}>
            {gpsBanner}
          </p>
        )}
        {speedUnknown && (
          <p role="status" style={{ fontSize: "1rem", margin: 0, opacity: 0.9 }}>
            No GPS speed — treating the truck as moving.
          </p>
        )}
        <div aria-label="Live map">{map}</div>
        {nextStop ? (
          <>
            <p style={{ fontSize: "1.1rem", opacity: 0.85, margin: 0 }}>Next stop</p>
            <p style={{ fontSize: "2rem", fontWeight: 800, lineHeight: 1.15, margin: 0 }}>{nextStop.name}</p>
            <p style={{ fontSize: "2.6rem", fontWeight: 800, margin: 0 }}>{nextStop.milesAway.toFixed(1)} mi</p>
          </>
        ) : (
          <p style={{ fontSize: "1.8rem", fontWeight: 700, margin: 0 }}>That&apos;s the run — every stop is done.</p>
        )}
        {upcoming && (
          <p style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
            {upcoming.arrow} {upcoming.instruction} · {upcoming.milesAway.toFixed(1)} mi
          </p>
        )}
        <p style={{ fontSize: "1.2rem", margin: 0 }}>
          {nextStop?.badge ?? ""}
          {driveLeftText ? ` · ${driveLeftText}` : ""}
        </p>
      </div>
      <div style={{ display: "flex", gap: "10px" }}>
        {nextStop && (
          <button type="button" onClick={onSkip} style={{ flex: 1, minHeight: "72px", fontSize: "1.2rem", fontWeight: 700 }}>
            Skip stop
          </button>
        )}
        <button type="button" onClick={onParked} style={{ flex: 1, minHeight: "72px", fontSize: "1.2rem", fontWeight: 700 }}>
          I&apos;m parked
        </button>
      </div>
    </div>
  );
}
