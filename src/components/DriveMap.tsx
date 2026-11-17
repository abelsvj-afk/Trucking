"use client";

// Drive Mode map (D1): the same keyless MapLibre/OSM stack as the
// Plan map, pointed the other way - instead of framing the whole
// route, it follows the truck. The position marker is a top-down
// semi-truck icon (Block C) that rotates with the heading, and it is
// honest about fix quality (G-1): solid blue on a usable fix, gray on
// a poor one, faded when the signal is lost - and it HOLDS the last
// real fix when signal is lost - no dead reckoning, ever.
// Home's mini map (Block C) runs it heading-up: zoomed in, the
// camera rotates so the truck always points up and stays centred,
// and the route line shows ONLY the part still ahead, in glowing
// gold — the part already driven is dropped from the line (map fix
// 2026-11-12: the traveled part used to stay drawn, dimmed, so it
// looked like he needed to turn around when he didn't). Callers pass
// the remaining geometry in `geometry`; there is no traveled overlay.

import { useCallback, useEffect, useRef } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LatLng } from "@/lib/smart-path";
import type { DriveStop, DriveStopStatus } from "@/lib/drive";
import { truckIconSvg, truckIcon3dSvg } from "@/lib/truck-icon";
import { DRIVE_MAP_PITCH_3D, driveMapCamera } from "@/lib/drive-map-camera";
import { segmentsToFeatureCollection, type MapSegment } from "@/lib/smart-path-map-segments";

export type DrivePositionQuality = "good" | "poor" | "lost";

/** Live awareness: a bridge / delay marker on the drive map (no popup while rolling — the banner speaks). */
export interface DriveMapHazard {
  id: string;
  point: LatLng;
  badge: string;
  color: string;
  title: string;
}

interface DriveMapProps {
  geometry: LatLng[];
  deadheadGeometry: LatLng[];
  stops: DriveStop[];
  stopStatus: DriveStopStatus[];
  position: LatLng | null;
  headingDeg: number | null;
  positionQuality: DrivePositionQuality | null;
  follow: boolean;
  onUserPan: () => void;
  night: boolean;
  height?: string;
  /** Block C: rotate the map so the heading points up (the truck icon then points up). */
  headingUp?: boolean;
  /** 3D driving view (owner 2026-11-17): tilted perspective, truck at the bottom, road ahead on top. Default false — Home mini map stays flat. 3D always implies heading-up. */
  view3d?: boolean;
  /** Block C: zoom used while following (omit to keep the current zoom). */
  followZoom?: number;
  /** Block C: false = no touch pan/zoom (a glance map that must not trap page scroll). Default true. */
  interactive?: boolean;
  /** Block C: false = do not fit the map to the route (follow mode owns the camera). Default true. */
  frameRoute?: boolean;
  /** Accessible label override. */
  label?: string;
  /** Live awareness: colored stretches (miles relative to the passed geometry). */
  segments?: MapSegment[];
  /** Live awareness: bridge / delay markers on the route. */
  hazards?: DriveMapHazard[];
}

const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
};

const FLORIDA_CENTER: [number, number] = [-81.7, 28.4];

/** The truck marker's face: flat top-down icon, or the perspective 3D rig in 3D view. Pure — both call sites pass explicit values. */
function renderTruckIconEl(
  icon: HTMLElement,
  opts: { quality: DrivePositionQuality | null; view3d: boolean; headingDeg: number | null; headingUp: boolean },
) {
  const poor = opts.quality === "poor" || opts.quality === "lost";
  const sig = `${poor}:${opts.quality === "lost"}:${opts.view3d}`;
  if (icon.dataset.sig !== sig) {
    icon.dataset.sig = sig;
    icon.innerHTML = opts.view3d
      ? truckIcon3dSvg({ color: poor ? "#9ca3af" : "#f2b705", opacity: opts.quality === "lost" ? 0.55 : 1, widthPx: 40 })
      : truckIconSvg({ color: poor ? "#9ca3af" : "#f2b705", opacity: opts.quality === "lost" ? 0.55 : 1, widthPx: 32 });
  }
  // Heading-up (3D always is): the map is rotated to the heading, so the truck points up on screen.
  // North-up: the icon itself rotates. No heading yet: it points up and nothing more is claimed.
  const rotation = opts.headingUp || opts.view3d ? 0 : (opts.headingDeg ?? 0);
  icon.style.transform = `rotate(${rotation}deg)`;
}

function lineFeature(points: LatLng[]) {
  return {
    type: "FeatureCollection" as const,
    features:
      points.length > 1
        ? [
            {
              type: "Feature" as const,
              properties: {},
              geometry: {
                type: "LineString" as const,
                coordinates: points.map((p) => [p.lng, p.lat]),
              },
            },
          ]
        : [],
  };
}

// Pin colors mirror the globals.css semantic tokens (audit Section
// D): white letters on the old #16a34a / #d97706 were 3.30:1 / 3.19:1;
// on the darkened success/warning/danger values they are 5.02:1 /
// 5.02:1 / 6.47:1.
const STOP_COLORS: Record<DriveStop["kind"], string> = {
  start: "#0f766a",
  pickup: "#15803d",
  delivery: "#b91c1c",
  rest: "#3f3f46",
  fuel: "#b45309",
  food: "#7c3aed",
  workout: "#e11d48",
};

export default function DriveMap({
  geometry,
  deadheadGeometry,
  stops,
  stopStatus,
  position,
  headingDeg,
  positionQuality,
  follow,
  onUserPan,
  night,
  height = "46vh",
  headingUp = false,
  view3d = false,
  followZoom,
  interactive = true,
  frameRoute = true,
  label,
  segments = [],
  hazards = [],
}: DriveMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const stopMarkersRef = useRef<MapLibreMarker[]>([]);
  const hazardMarkersRef = useRef<MapLibreMarker[]>([]);
  const positionMarkerRef = useRef<MapLibreMarker | null>(null);
  const positionElRef = useRef<HTMLDivElement | null>(null);
  const lastCameraMoveRef = useRef(0);
  const framedRef = useRef(false);
  const dataRef = useRef({ geometry, deadheadGeometry, stops, stopStatus, segments, hazards });
  const frameRouteRef = useRef(frameRoute);
  const followRef = useRef(follow);
  const panRef = useRef(onUserPan);
  const view3dRef = useRef(view3d);
  const lastPositionRef = useRef<LatLng | null>(null);
  const lastHeadingRef = useRef<number | null>(null);
  const qualityRef = useRef(positionQuality);
  useEffect(() => {
    view3dRef.current = view3d;
  }, [view3d]);
  useEffect(() => {
    qualityRef.current = positionQuality;
  }, [positionQuality]);
  // Ref syncs live in effects, never in render (react-hooks/refs,
  // same discipline as SmartPathMap).
  useEffect(() => {
    followRef.current = follow;
    frameRouteRef.current = frameRoute;
  }, [follow, frameRoute]);
  useEffect(() => {
    panRef.current = onUserPan;
  }, [onUserPan]);

  // Aim the camera: tilt + truck-at-the-bottom in 3D, flat in 2D.
  // With a position and follow on, the camera centres on the truck;
  // without one (toggle while parked) it only re-aims the tilt.
  const applyCamera = useCallback(
    (pos: LatLng | null) => {
      const map = mapRef.current;
      if (!map) return;
      const cam = driveMapCamera({
        view3d: view3dRef.current,
        headingDeg: lastHeadingRef.current,
        headingUp: headingUp || view3dRef.current,
        followZoom,
        containerHeightPx: containerRef.current?.clientHeight ?? 0,
      });
      if (pos && followRef.current) {
        map.easeTo({
          center: [pos.lng, pos.lat],
          duration: 700,
          pitch: cam.pitch,
          ...(cam.bearing !== null ? { bearing: cam.bearing } : {}),
          ...(cam.zoom !== null ? { zoom: cam.zoom } : {}),
          offset: cam.offset,
        });
      } else {
        map.easeTo({ duration: 700, pitch: cam.pitch, offset: cam.offset });
      }
    },
    [headingUp, followZoom],
  );

  const drawRoute = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("drive-route")) return;
    const {
      geometry: geo,
      deadheadGeometry: deadhead,
      stops: currentStops,
      stopStatus: statuses,
      segments: currentSegments,
      hazards: currentHazards,
    } = dataRef.current;
    const routeSource = map.getSource("drive-route") as
      | { setData: (data: unknown) => void }
      | undefined;
    routeSource?.setData(lineFeature(geo));
    const deadheadSource = map.getSource("drive-deadhead") as
      | { setData: (data: unknown) => void }
      | undefined;
    deadheadSource?.setData(lineFeature(deadhead));
    // Live awareness: the colored stretches over the remaining
    // route line, each feature carrying its severity color.
    const trafficSource = map.getSource("drive-traffic") as
      | { setData: (data: unknown) => void }
      | undefined;
    trafficSource?.setData(segmentsToFeatureCollection(geo, currentSegments));

    void (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      for (const marker of stopMarkersRef.current) marker.remove();
      stopMarkersRef.current = currentStops.map((stop, i) => {
        const status = statuses[i] ?? "pending";
        const el = document.createElement("div");
        el.textContent = status === "arrived" ? "✓" : stop.badge;
        el.setAttribute("aria-hidden", "true");
        const dimmed = status === "skipped" || status === "missed";
        el.style.cssText =
          `background:${dimmed ? "#6b7280" : STOP_COLORS[stop.kind]};color:#fff;border-radius:9999px;` +
          "min-width:24px;height:24px;display:flex;align-items:center;justify-content:center;" +
          `font-size:11px;font-weight:700;padding:0 5px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);opacity:${status === "arrived" || dimmed ? 0.75 : 1}`;
        return new maplibregl.Marker({ element: el })
          .setLngLat([stop.point.lng, stop.point.lat])
          .addTo(map);
      });

      // Hazard markers: a plain badge, no popup while rolling — the
      // banner above the map carries the words.
      for (const marker of hazardMarkersRef.current) marker.remove();
      hazardMarkersRef.current = currentHazards.map((hazard) => {
        const el = document.createElement("div");
        el.textContent = hazard.badge;
        el.setAttribute("aria-hidden", "true");
        el.style.cssText =
          `background:${hazard.color};color:#fff;border-radius:9999px;` +
          "min-width:24px;height:24px;display:flex;align-items:center;justify-content:center;" +
          "font-size:12px;font-weight:700;padding:0 5px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);";
        return new maplibregl.Marker({ element: el })
          .setLngLat([hazard.point.lng, hazard.point.lat])
          .addTo(map);
      });

      if (frameRouteRef.current && !framedRef.current && geo.length > 0) {
        framedRef.current = true;
        const all = [...geo, ...deadhead];
        const bounds = new maplibregl.LngLatBounds(
          [all[0]!.lng, all[0]!.lat],
          [all[0]!.lng, all[0]!.lat],
        );
        for (const point of all) bounds.extend([point.lng, point.lat]);
        map.fitBounds(bounds, { padding: 40, maxZoom: 11, duration: 0 });
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (cancelled || !containerRef.current || mapRef.current) return;
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: OSM_STYLE,
        center: FLORIDA_CENTER,
        zoom: 6,
        // 3D starts tilted (the toggle re-aims it later); flat starts top-down.
        pitch: view3dRef.current ? DRIVE_MAP_PITCH_3D : 0,
        attributionControl: { compact: true },
        interactive,
      });
      mapRef.current = map;
      // A user drag is the signal to stop following (G-5's one-tap
      // re-center is how follow comes back). Programmatic easeTo
      // does not fire dragstart, so the camera never fights itself.
      map.on("dragstart", () => panRef.current());
      map.on("load", () => {
        map.addSource("drive-deadhead", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "drive-deadhead-line",
          type: "line",
          source: "drive-deadhead",
          paint: {
            "line-color": "#0f766a",
            "line-width": 4,
            "line-dasharray": [2, 1.5],
            "line-opacity": 0.9,
          },
        });
        map.addSource("drive-route", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "drive-route-glow",
          type: "line",
          source: "drive-route",
          paint: { "line-color": "#f2b705", "line-width": 12, "line-opacity": 0.4, "line-blur": 6 },
        });
        map.addLayer({
          id: "drive-route-casing",
          type: "line",
          source: "drive-route",
          paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
        });
        // The remaining route, glowing brand gold (#c9a227) — the only line on the map.
        map.addLayer({
          id: "drive-route-line",
          type: "line",
          source: "drive-route",
          paint: { "line-color": "#c9a227", "line-width": 5, "line-opacity": 0.9 },
        });
        // Live awareness: colored stretches over the route line,
        // each feature carrying its severity color.
        map.addSource("drive-traffic", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "drive-traffic-line",
          type: "line",
          source: "drive-traffic",
          paint: {
            "line-color": ["get", "color"],
            "line-width": 7,
            "line-opacity": 0.95,
          },
        });
        drawRoute();
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the map is created once; `interactive` is a mount-time choice
  }, [drawRoute]);

  useEffect(() => {
    dataRef.current = { geometry, deadheadGeometry, stops, stopStatus, segments, hazards };
    drawRoute();
  }, [geometry, deadheadGeometry, stops, stopStatus, segments, hazards, drawRoute]);

  // Position marker + follow camera. Camera moves at most 1 Hz
  // and only on real movement (G-5 battery discipline).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position) return;
    lastPositionRef.current = position;
    lastHeadingRef.current = headingDeg;
    void (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (!positionMarkerRef.current) {
        const el = document.createElement("div");
        el.setAttribute("aria-hidden", "true");
        el.style.cssText = "display:flex;align-items:center;justify-content:center;pointer-events:none";
        const icon = document.createElement("div");
        icon.style.cssText = "transform-origin:50% 50%;transition:transform .5s linear";
        el.appendChild(icon);
        positionElRef.current = el;
        positionMarkerRef.current = new maplibregl.Marker({ element: el })
          .setLngLat([position.lng, position.lat])
          .addTo(map);
      }
      const marker = positionMarkerRef.current;
      marker.setLngLat([position.lng, position.lat]);
      const el = positionElRef.current;
      if (el) {
        const icon = el.firstElementChild as HTMLElement | null;
        if (icon) {
          renderTruckIconEl(icon, {
            quality: positionQuality,
            view3d: view3dRef.current,
            headingDeg,
            headingUp,
          });
        }
      }
      if (followRef.current) {
        const now = Date.now();
        if (now - lastCameraMoveRef.current >= 1000) {
          lastCameraMoveRef.current = now;
          applyCamera(position);
        }
      }
    })();
  }, [position, headingDeg, positionQuality, headingUp, followZoom, view3d, applyCamera]);

  // Toggling 3D re-aims the camera and swaps the truck now — not only on the next fix.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const el = positionElRef.current;
    if (el) {
      const icon = el.firstElementChild as HTMLElement | null;
      if (icon) {
        renderTruckIconEl(icon, {
          quality: qualityRef.current,
          view3d,
          headingDeg: lastHeadingRef.current,
          headingUp,
        });
      }
    }
    applyCamera(lastPositionRef.current);
  }, [view3d, headingUp, applyCamera]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={label ?? "Drive map following your position along the planned route"}
      style={{
        width: "100%",
        height,
        borderRadius: "12px",
        overflow: "hidden",
        // Night posture (G-5): dim the raster tiles after dark so
        // the map stops glaring in a dark cab.
        filter: night ? "brightness(0.72) contrast(1.05)" : undefined,
      }}
    />
  );
}
