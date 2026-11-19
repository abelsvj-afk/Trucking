"use client";

// Drive Mode map (D1): the same keyless MapLibre/OSM stack as the
// Plan map, pointed the other way - instead of framing the whole
// route, it follows the truck. In the flat view the position marker
// is a top-down semi-truck icon (Block C) that rotates with the
// heading; in the 3D view the truck is a REAL 3D model (a low-poly
// semi, drawn by a MapLibre custom WebGL layer — see
// truck-map-layer.ts), and there is no HTML marker at all. Both are
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

import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LatLng } from "@/lib/smart-path";
import type { DriveStop, DriveStopStatus } from "@/lib/drive";
import { truckIconSvg } from "@/lib/truck-icon";
import { createTruckMapLayer, TRUCK_MAP_LAYER_ID, type TruckLayerState } from "@/lib/truck-map-layer";
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

// The maplibre namespace is imported exactly once, when the map is
// created; every later use reads it from a ref. The loader's return
// type IS the namespace type, so the ref is typed by the real module,
// not a re-declaration.
async function loadMapLibre() {
  return (await import("maplibre-gl")).default;
}
type MapLibreNamespace = Awaited<ReturnType<typeof loadMapLibre>>;

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
  /** 3D driving view (owner 2026-11-17): tilted perspective, a real 3D truck model at the bottom, road ahead on top. Default false. 3D always implies heading-up. */
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

/** The truck marker's face: the flat top-down icon. In 3D view there is no HTML marker at all — the truck is a real 3D model drawn by the custom layer (truck-map-layer.ts). Pure — both call sites pass explicit values. */
function renderTruckIconEl(
  icon: HTMLElement,
  opts: { quality: DrivePositionQuality | null; headingDeg: number | null; headingUp: boolean },
) {
  const poor = opts.quality === "poor" || opts.quality === "lost";
  const sig = `${poor}:${opts.quality === "lost"}`;
  if (icon.dataset.sig !== sig) {
    icon.dataset.sig = sig;
    icon.innerHTML = truckIconSvg({ color: poor ? "#9ca3af" : "#f2b705", opacity: opts.quality === "lost" ? 0.55 : 1, widthPx: 32 });
  }
  // Heading-up: the map is rotated to the heading, so the truck points up on screen.
  // North-up: the icon itself rotates. No heading yet: it points up and nothing more is claimed.
  const rotation = opts.headingUp ? 0 : (opts.headingDeg ?? 0);
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
  // The maplibre namespace, imported once when the map is created.
  // Every later use (truck layer, markers, route framing) reads it
  // from here instead of re-importing on every call.
  const maplibreRef = useRef<MapLibreNamespace | null>(null);
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
  // The 3D model's live state: the custom layer reads this on every
  // render, so the model follows the newest fix without re-adding.
  // Seeded from the latest fix in the position effect below — even
  // before the map exists, so a fix that arrives while the map is
  // still loading is not dropped (2026-11-17: the first fix used to
  // be lost that way and the truck stayed invisible until the next
  // one).
  const truckLayerStateRef = useRef<TruckLayerState | null>(null);
  // The 3D layer failed to initialise on this mount (on a real phone
  // that is the WebGL1 fallback: three.js r163+ refuses a WebGL1
  // context, while MapLibre silently falls back to one when WebGL2
  // creation fails — and the layer is already registered by then, so
  // without this flag the map would keep "having" a truck layer that
  // can never draw). While set, the flat 2D icon is the truck — a
  // visible truck beats an invisible one. Kept as state (so the
  // position effect re-runs and the marker comes back at once) with
  // a ref mirror for the stable callbacks.
  const [truckLayerFailed, setTruckLayerFailed] = useState(false);
  const truckLayerFailedRef = useRef(false);
  const markTruckLayerFailed = useCallback((error: unknown) => {
    console.error("[DriveMap] 3D truck layer failed to initialise; falling back to the flat truck icon.", error);
    truckLayerFailedRef.current = true;
    setTruckLayerFailed(true);
  }, []);
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
  // With a position and follow on, the camera centres on the truck at
  // street-level follow zoom; without one (toggle while parked) it
  // only re-aims the tilt. Follow zoom and bearing are follow
  // properties, not 3D ones — a flat following map still zooms in
  // and rotates with the heading.
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
        follow: followRef.current,
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

  // The 3D truck model lives in a MapLibre custom layer (real
  // geometry, not an icon). Added when the 3D view is on, removed
  // when it is off. Only after the style has loaded — addLayer
  // before that throws. The map-load handler calls this too, so a
  // map created while 3D is already on still gets its truck.
  // The maplibre namespace is imported ONCE, at map creation
  // (maplibreRef), and reused here — re-importing it on every call
  // is pointless work, and the position effect used to do it on
  // every fix.
  // Failure is NOT silent (2026-11-17: the truck vanished with no
  // error anywhere): if addLayer throws — on a real phone that is
  // the three.js WebGL1 refusal, because MapLibre falls back to a
  // WebGL1 context when WebGL2 creation fails — the half-registered
  // layer is removed (MapLibre registers it BEFORE calling onAdd,
  // so getLayer would keep reporting it as present and no retry
  // would ever happen) and the flat 2D icon takes over as the
  // truck. The error is logged in full.
  const syncTruckLayer = useCallback(() => {
    const map = mapRef.current;
    const maplibregl = maplibreRef.current;
    if (!map || !maplibregl || !map.isStyleLoaded()) return;
    const has = Boolean(map.getLayer(TRUCK_MAP_LAYER_ID));
    if (!view3dRef.current) {
      if (has) {
        try {
          map.removeLayer(TRUCK_MAP_LAYER_ID);
        } catch {
          // Already gone (e.g. removed by the failure path below).
        }
      }
      return;
    }
    if (truckLayerFailedRef.current || has) return;
    try {
      map.addLayer(
        createTruckMapLayer(
          () => truckLayerStateRef.current,
          (pos) => {
            const mc = maplibregl.MercatorCoordinate.fromLngLat([pos.lng, pos.lat], 0);
            return { x: mc.x, y: mc.y, z: mc.z, metersPerUnit: mc.meterInMercatorCoordinateUnits() };
          },
        ),
      );
    } catch (error) {
      markTruckLayerFailed(error);
      try {
        if (map.getLayer(TRUCK_MAP_LAYER_ID)) map.removeLayer(TRUCK_MAP_LAYER_ID);
      } catch {
        // Best effort: the layer is dead either way.
      }
    }
  }, [markTruckLayerFailed]);

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

    (() => {
      const maplibregl = maplibreRef.current;
      if (!maplibregl) return;
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

      // Whole-route framing is for plan/overview only. While following,
      // the follow camera owns the framing — fitting the whole route
      // here would park the driver on a zoomed-out state view until
      // the next position fix re-aims it.
      if (frameRouteRef.current && !framedRef.current && geo.length > 0 && !followRef.current) {
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
      const maplibregl = await loadMapLibre();
      maplibreRef.current = maplibregl;
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
        void syncTruckLayer();
      });
    })();
    return () => {
      cancelled = true;
      // The map owns a WebGL context: destroy it on unmount, or
      // every remount leaks one. Browsers cap contexts per page, and
      // once the cap is hit new maps fall back to WebGL1 — which is
      // exactly what makes the three.js 3D layer refuse to initialise
      // (2026-11-17: the truck vanished after repeated Home
      // show/hide flips, each leaking a context).
      const map = mapRef.current;
      if (map) {
        map.remove();
        mapRef.current = null;
      }
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
    // Seed the 3D model's state from the latest fix BEFORE the
    // map check: a fix that arrives while the map is still loading
    // used to be dropped here, and the truck stayed invisible until
    // the next fix (on the Drive surface that is the next GPS fix,
    // not a timer). A null position never clears the last real fix.
    lastPositionRef.current = position;
    lastHeadingRef.current = headingDeg;
    if (position) truckLayerStateRef.current = { position, headingDeg };
    const map = mapRef.current;
    if (!map || !position) return;
    if (view3dRef.current && !truckLayerFailed) {
      // No HTML marker in 3D view — the model IS the truck. Repaint
      // so the layer sees the new fix; it then glides to it and
      // stops asking for frames once it arrives (truck-motion.ts).
      map.triggerRepaint();
      if (followRef.current) {
        const now = Date.now();
        if (now - lastCameraMoveRef.current >= 1000) {
          lastCameraMoveRef.current = now;
          applyCamera(position);
        }
      }
      return;
    }
    {
      const maplibregl = maplibreRef.current;
      if (!maplibregl) return;
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
      if (!marker) return;
      marker.setLngLat([position.lng, position.lat]);
      const el = positionElRef.current;
      if (el) {
        const icon = el.firstElementChild as HTMLElement | null;
        if (icon) {
          renderTruckIconEl(icon, {
            quality: positionQuality,
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
    }
  }, [position, headingDeg, positionQuality, headingUp, followZoom, view3d, truckLayerFailed, applyCamera]);

  // Toggling 3D re-aims the camera and swaps the truck now — not only on the next fix.
  // 3D on: the HTML marker goes away (the model takes its place) and the layer is added.
  // 3D off: the layer is removed; the marker comes back via the position effect
  // (view3d is one of its deps). When the layer failed to initialise,
  // the marker stays: it IS the truck now (see syncTruckLayer).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (view3d && !truckLayerFailed) {
      positionMarkerRef.current?.remove();
      positionMarkerRef.current = null;
      positionElRef.current = null;
    } else {
      const el = positionElRef.current;
      if (el) {
        const icon = el.firstElementChild as HTMLElement | null;
        if (icon) {
          renderTruckIconEl(icon, {
            quality: qualityRef.current,
            headingDeg: lastHeadingRef.current,
            headingUp,
          });
        }
      }
    }
    void syncTruckLayer();
    applyCamera(lastPositionRef.current);
  }, [view3d, headingUp, truckLayerFailed, applyCamera, syncTruckLayer]);

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
