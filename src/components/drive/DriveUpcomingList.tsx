// Drive's upcoming-distance list (audit-fix B7, 2026-11-18): the
// left-hand cards over the drive map, in the shape the owner showed
// on the 2026-11-18 call — a maneuver card on top (arrow, plain
// instruction, miles with one decimal, exit number when the
// instruction names one), truck POIs below it with live distances,
// and the remaining run along the bottom (miles, time, arrival
// time). Display-only: pointer-events none, so it never traps a
// tap meant for the map. All distances tick live — the page feeds
// it the smoothed progress, so 7.8 becomes 7.7 as he rolls.
//
// Times read on the driver's clock (America/New_York, the app's
// standing zone) — never UTC, never a bare server time.

import type { TruckPoiKind } from "@/services/integrations/overpass-truck-pois";

export interface UpcomingListManeuver {
  arrow: string;
  instruction: string;
  milesAway: number;
}

export interface UpcomingListPoi {
  id: string;
  kind: TruckPoiKind;
  name: string | null;
  milesAway: number;
}

export interface UpcomingListRemaining {
  milesLeft: number;
  minutesLeft: number | null;
  /** Arrival time on the driver's clock; null when it cannot be timed. */
  etaAt: Date | null;
}

interface Props {
  maneuver: UpcomingListManeuver | null;
  pois: UpcomingListPoi[];
  remaining: UpcomingListRemaining | null;
}

const POI_META: Record<TruckPoiKind, { badge: string; label: string; color: string }> = {
  fuel: { badge: "⛽", label: "Fuel", color: "#b45309" },
  rest: { badge: "R", label: "Rest area", color: "#2563eb" },
  parking: { badge: "P", label: "Truck parking", color: "#0f766a" },
};

/** "Take exit 174" -> "174"; null when the instruction names no exit. */
export function exitNumber(instruction: string): string | null {
  const match = instruction.match(/exit\s*(\d+[a-z]?)/i);
  return match ? match[1]! : null;
}

function formatEta(etaAt: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(etaAt);
}

function formatMinutesLeft(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export default function DriveUpcomingList({ maneuver, pois, remaining }: Props) {
  if (!maneuver && pois.length === 0 && !remaining) return null;
  const exit = maneuver ? exitNumber(maneuver.instruction) : null;
  return (
    <div
      aria-label="Up ahead"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "8px",
        gap: "8px",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
        {maneuver && (
          <div
            style={{
              background: "rgba(17, 24, 39, 0.92)",
              color: "#f9fafb",
              borderRadius: "12px",
              padding: "10px 12px",
              maxWidth: "230px",
              boxShadow: "0 2px 8px rgba(0,0,0,.35)",
            }}
          >
            <p style={{ margin: 0, fontSize: "1.6rem", lineHeight: 1.1 }}>
              <span aria-hidden="true">{maneuver.arrow} </span>
              {maneuver.instruction}
            </p>
            <p style={{ margin: "4px 0 0", fontSize: "2rem", fontWeight: 800, lineHeight: 1 }}>
              {Math.max(0, maneuver.milesAway).toFixed(1)}
              <span style={{ fontSize: "1.1rem", fontWeight: 600 }}> mi</span>
            </p>
            {exit && (
              <p
                style={{
                  display: "inline-block",
                  margin: "8px 0 0",
                  padding: "2px 10px",
                  borderRadius: "6px",
                  background: "#15803d",
                  color: "#fff",
                  fontSize: "1.1rem",
                  fontWeight: 700,
                }}
              >
                ↗ Exit {exit}
              </p>
            )}
          </div>
        )}
        {pois.map((poi) => {
          const meta = POI_META[poi.kind];
          return (
            <div
              key={poi.id}
              style={{
                background: "rgba(255,255,255,0.95)",
                color: "#111827",
                borderRadius: "10px",
                padding: "6px 10px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                boxShadow: "0 1px 4px rgba(0,0,0,.3)",
                maxWidth: "230px",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: "26px",
                  height: "26px",
                  borderRadius: "9999px",
                  border: `2px solid ${meta.color}`,
                  color: meta.color,
                  fontSize: "0.95rem",
                  fontWeight: 800,
                }}
              >
                {meta.badge}
              </span>
              <span
                style={{
                  fontSize: "1.05rem",
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {poi.name ?? meta.label}
              </span>
              <span style={{ fontSize: "1.25rem", fontWeight: 800, marginLeft: "auto", whiteSpace: "nowrap" }}>
                {Math.max(0, poi.milesAway).toFixed(1)}
                <span style={{ fontSize: "0.9rem", fontWeight: 600 }}> mi</span>
              </span>
            </div>
          );
        })}
      </div>
      {remaining && (
        <div
          style={{
            alignSelf: "center",
            background: "rgba(255,255,255,0.95)",
            color: "#111827",
            borderRadius: "12px",
            padding: "8px 16px",
            textAlign: "center",
            boxShadow: "0 1px 4px rgba(0,0,0,.3)",
          }}
        >
          <p style={{ margin: 0, fontSize: "1.4rem", fontWeight: 800, lineHeight: 1.2 }}>
            {Math.max(0, remaining.milesLeft).toFixed(1)} mi
            {remaining.minutesLeft !== null ? `  |  ${formatMinutesLeft(remaining.minutesLeft)}` : ""}
          </p>
          {remaining.etaAt && (
            <p style={{ margin: 0, fontSize: "1.05rem", color: "#4b5563" }}>
              Arrive about {formatEta(remaining.etaAt)} ET
            </p>
          )}
        </div>
      )}
    </div>
  );
}
