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
// Times read on the driver's clock — the phone's own timezone (he
// crosses zones on the road) — never UTC, never a bare server time.

import { useState, type ReactNode } from "react";
import type { TruckPoiKind } from "@/services/integrations/overpass-truck-pois";
import { viewerTimeZone } from "@/lib/time";
import { zoneShortLabel } from "@/lib/display-zone";
import { speedTone } from "@/lib/drive-where";

/** What the list can show: truck POIs plus low/unknown-clearance bridges on the route. */
export type UpcomingListKind = TruckPoiKind | "bridge" | "roadwork" | "voice";

export interface UpcomingListManeuver {
  arrow: string;
  instruction: string;
  milesAway: number;
}

export interface UpcomingListPoi {
  id: string;
  kind: UpcomingListKind;
  name: string | null;
  milesAway: number;
  /** Voice notes: shake + pulse until listened and passed; tap to listen. */
  alert?: boolean;
  onTap?: () => void;
  /** e.g. "Low bridge · 12 min ago · 2 drivers" */
  detail?: string;
  /** After listening: "It's gone" / "Wrong note". */
  actions?: { label: string; onClick: () => void }[];
}

export interface UpcomingListRemaining {
  milesLeft: number;
  minutesLeft: number | null;
  /** Arrival time on the driver's clock; null when it cannot be timed. */
  etaAt: Date | null;
  /** The zone to show it in — where the truck is now (the page passes it); defaults to the phone's. */
  timeZone?: string;
}

interface Props {
  maneuver: UpcomingListManeuver | null;
  pois: UpcomingListPoi[];
  remaining: UpcomingListRemaining | null;
  /** Posted limit (OSM, null = unknown → no limit shown) and GPS speed (TruckPath-style box, 2026-11-19). */
  speed?: { limitMph: number | null; speedMph: number | null } | null;
  /** "I-10 W · MM245" / "Greenville · FL" — only known parts. */
  where?: { top: string | null; bottom: string | null } | null;
  /** The mic (VoiceNoteRecorder), bottom-right over the map. */
  recorder?: ReactNode;
  /** Keep clear of the map's own bottom overlay (Home's speed badge), in px. */
  bottomInsetPx?: number;
}

const TONE_COLOR = { normal: "#111827", over: "#ea580c", well_over: "#dc2626" } as const;

export const POI_META: Record<UpcomingListKind, { badge: string; label: string; color: string }> = {
  truck_stop: { badge: "T", label: "Truck stop", color: "#c9a227" },
  bridge: { badge: "⚠", label: "Low bridge", color: "#b91c1c" },
  roadwork: { badge: "🚧", label: "Road work", color: "#f97316" },
  voice: { badge: "🎙", label: "Voice note", color: "#c9a227" },
  fuel: { badge: "⛽", label: "Fuel", color: "#b45309" },
  rest: { badge: "R", label: "Rest area", color: "#2563eb" },
  parking: { badge: "P", label: "Truck parking", color: "#0f766a" },
};

/** "Take exit 174" -> "174"; null when the instruction names no exit. */
export function exitNumber(instruction: string): string | null {
  const match = instruction.match(/exit\s*(\d+[a-z]?)/i);
  return match ? match[1]! : null;
}

/** " CT" after the arrival time (TruckPath shows the zone, 2026-11-19). Never "UTC": a zone that reads as UTC gets no label. */
export function etaZoneLabel(timeZone: string = viewerTimeZone()): string {
  const label = zoneShortLabel(timeZone);
  return /^(UTC|GMT|Etc\/)/.test(label) || /^(UTC|Etc\/)/.test(timeZone) ? "" : ` ${label}`;
}

/** "4:35 PM" on the driver's own clock (the phone's zone). */
export function formatEta(etaAt: Date, timeZone: string = viewerTimeZone()): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(etaAt);
}

/**
 * Time left that ticks like the miles do: under 10 minutes it counts
 * the seconds down too (8m 20s, 8m 10s), above that minutes (1h 04m).
 */
export function formatMinutesLeft(minutes: number): string {
  if (minutes < 10) {
    const secs = Math.max(0, Math.round(minutes * 6)) * 10; // 10-second steps
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, "0")}s`;
  }
  const rounded = Math.max(0, Math.round(minutes));
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Chips shown before More (TruckPath shows three). */
const CHIPS_SHOWN = 3;

export default function DriveUpcomingList({ maneuver, pois, remaining, speed = null, where = null, recorder = null, bottomInsetPx = 0 }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!maneuver && pois.length === 0 && !remaining && !speed && !where?.top && !where?.bottom && !recorder) return null;
  const tone = speedTone(speed?.speedMph ?? null, speed?.limitMph ?? null);
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
        padding: `8px 8px ${8 + bottomInsetPx}px`,
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
      </div>
      {pois.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start" }}>
          {(expanded ? pois : pois.slice(0, CHIPS_SHOWN)).map((poi) => {
            const meta = POI_META[poi.kind];
            const tappable = Boolean(poi.onTap);
            return (
              <div
                key={poi.id}
                role={tappable ? "button" : undefined}
                tabIndex={tappable ? 0 : undefined}
                aria-label={tappable ? `${poi.name ?? meta.label}, ${Math.max(0, poi.milesAway).toFixed(1)} miles. Tap to listen.` : undefined}
                onClick={poi.onTap}
                onKeyDown={tappable ? (e) => (e.key === "Enter" || e.key === " ") && poi.onTap?.() : undefined}
                className={poi.alert ? "voice-note-alert" : undefined}
                style={{
                  pointerEvents: tappable || poi.actions ? "auto" : undefined,
                  flexWrap: "wrap",
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
                  role="img"
                  aria-label={meta.label}
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
                  <span className={poi.alert ? "voice-note-shake" : undefined}>{meta.badge}</span>
                </span>
                {(expanded || poi.kind === "voice") && (
                  <span style={{ fontSize: "1rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {poi.name ?? meta.label}
                    {poi.detail && <span style={{ display: "block", fontSize: "0.8rem", fontWeight: 500, color: "#4b5563" }}>{poi.detail}</span>}
                  </span>
                )}
                <span style={{ fontSize: "1.25rem", fontWeight: 800, marginLeft: "auto", whiteSpace: "nowrap" }}>
                  {Math.max(0, poi.milesAway).toFixed(1)}
                  <span style={{ fontSize: "0.9rem", fontWeight: 600 }}> mi</span>
                </span>
                {poi.actions && (
                  <span style={{ display: "flex", gap: "6px", width: "100%" }}>
                    {poi.actions.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          a.onClick();
                        }}
                        style={{ flex: 1, padding: "6px", fontWeight: 700 }}
                      >
                        {a.label}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            );
          })}
          {pois.length > CHIPS_SHOWN || !expanded ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              style={{ pointerEvents: "auto", borderRadius: "10px", padding: "4px 12px", fontWeight: 700 }}
            >
              {expanded ? "▴ Less" : "▾ More"}
            </button>
          ) : null}
        </div>
      )}
      {(speed || where?.top || where?.bottom) && (
        <div style={{ display: "flex", alignItems: "flex-end", gap: "8px" }}>
          {speed && (speed.limitMph !== null || speed.speedMph !== null) && (
            <div
              style={{ display: "flex", gap: "8px", background: "rgba(255,255,255,0.95)", borderRadius: "10px", padding: "4px 8px", boxShadow: "0 1px 4px rgba(0,0,0,.3)" }}
            >
              {speed.limitMph !== null && (
                <div role="img" aria-label={`Speed limit ${speed.limitMph}`} style={{ border: "2px solid #111827", borderRadius: "6px", padding: "0 6px", textAlign: "center", color: "#111827" }}>
                  <div style={{ fontSize: "1.4rem", fontWeight: 800, lineHeight: 1.1 }}>{speed.limitMph}</div>
                  <div style={{ fontSize: "0.65rem", fontWeight: 700 }}>LIMIT</div>
                </div>
              )}
              {speed.speedMph !== null && (
                <div aria-label={`Your speed ${Math.round(speed.speedMph)} miles per hour`} style={{ textAlign: "center", color: TONE_COLOR[tone] }}>
                  <div style={{ fontSize: "1.4rem", fontWeight: 800, lineHeight: 1.1 }}>{Math.round(speed.speedMph)}</div>
                  <div style={{ fontSize: "0.65rem", fontWeight: 700 }}>MPH</div>
                </div>
              )}
            </div>
          )}
          {(where?.top || where?.bottom) && (
            <div style={{ background: "rgba(255,255,255,0.95)", color: "#374151", borderRadius: "10px", padding: "4px 10px", boxShadow: "0 1px 4px rgba(0,0,0,.3)", textAlign: "center", maxWidth: "200px" }}>
              {where?.top && <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "#111827" }}>{where.top}</div>}
              {where?.bottom && <div style={{ fontSize: "0.85rem" }}>{where.bottom}</div>}
            </div>
          )}
        </div>
      )}
      {recorder && <div style={{ position: "absolute", right: "8px", bottom: "96px" }}>{recorder}</div>}
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
              Arrive about {formatEta(remaining.etaAt, remaining.timeZone)}
              {etaZoneLabel(remaining.timeZone)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
