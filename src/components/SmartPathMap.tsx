"use client";

// Smart Path (docs/design/driver-mvp.md §8.1). The native in-app
// map: MapLibre GL JS over OpenStreetMap raster tiles - keyless, so
// nothing about an API key can block it. The engine is borrowed; the
// layers (route, deadhead, sleep/fuel/food/workout stops) are this
// app's.
//
// The style below is the one place a future tile provider swaps in.
// Limits are stated in the design doc: OSM tiles are fair-use at this
// scale and there is no traffic layer. The caption under the map is
// supplied by the page - this component owns no route copy of its
// own (Piece 1, P1-1).

import { useCallback, useEffect, useRef } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LatLng } from "@/lib/smart-path";

export type SmartPathStopKind =
  | "start"
  | "origin"
  | "destination"
  | "rest"
  | "fuel"
  | "food"
  | "workout";

export interface SmartPathMapStop {
  id: string;
  kind: SmartPathStopKind;
  point: LatLng;
  badge: string;
  color: string;
  title: string;
  lines: string[];
  mapsUrl?: string;
}

interface SmartPathMapProps {
  geometry: LatLng[];
  stops: SmartPathMapStop[];
  deadheadGeometry?: LatLng[];
  caption: string;
  height?: string;
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

const LEGEND_LABELS: { kind: SmartPathStopKind; label: string }[] = [
  { kind: "start", label: "Start" },
  { kind: "origin", label: "Pickup" },
  { kind: "destination", label: "Delivery" },
  { kind: "rest", label: "Sleep" },
  { kind: "fuel", label: "Fuel" },
  { kind: "food", label: "Food" },
  { kind: "workout", label: "Workout" },
];

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

export default function SmartPathMap({
  geometry,
  stops,
  deadheadGeometry = [],
  caption,
  height = "clamp(340px, 55vh, 520px)",
}: SmartPathMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const dataRef = useRef({ geometry, stops, deadheadGeometry });

  const draw = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("smart-path-route")) return;
    void (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      const {
        geometry: geo,
        stops: currentStops,
        deadheadGeometry: deadhead,
      } = dataRef.current;

      const routeSource = map.getSource("smart-path-route") as
        | { setData: (data: unknown) => void }
        | undefined;
      routeSource?.setData(lineFeature(geo));

      const deadheadSource = map.getSource("smart-path-deadhead") as
        | { setData: (data: unknown) => void }
        | undefined;
      deadheadSource?.setData(lineFeature(deadhead));

      for (const marker of markersRef.current) marker.remove();
      markersRef.current = currentStops.map((stop) => {
        const el = document.createElement("div");
        el.textContent = stop.badge;
        el.setAttribute("role", "button");
        el.setAttribute("aria-label", `${stop.title}. ${stop.lines.join(" ")}`);
        el.style.cssText =
          `background:${stop.color};color:#fff;border-radius:9999px;` +
          "min-width:28px;height:28px;display:flex;align-items:center;justify-content:center;" +
          "font-size:13px;font-weight:700;padding:0 6px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);" +
          "cursor:pointer";

        // Popup DOM is built only with createElement + textContent:
        // stop names come from OpenStreetMap tags and are untrusted,
        // so innerHTML is never used here.
        const popupEl = document.createElement("div");
        const titleEl = document.createElement("div");
        titleEl.textContent = stop.title;
        titleEl.style.fontWeight = "700";
        popupEl.appendChild(titleEl);
        for (const line of stop.lines) {
          const lineEl = document.createElement("div");
          lineEl.textContent = line;
          popupEl.appendChild(lineEl);
        }
        if (stop.mapsUrl) {
          const linkEl = document.createElement("a");
          linkEl.href = stop.mapsUrl;
          linkEl.target = "_blank";
          linkEl.rel = "noreferrer";
          linkEl.textContent = "Open in Google Maps";
          popupEl.appendChild(linkEl);
        }
        const popup = new maplibregl.Popup({
          offset: 18,
          closeButton: false,
          maxWidth: "260px",
        }).setDOMContent(popupEl);

        return new maplibregl.Marker({ element: el })
          .setLngLat([stop.point.lng, stop.point.lat])
          .setPopup(popup)
          .addTo(map);
      });

      const all = [...geo, ...deadhead, ...currentStops.map((s) => s.point)];
      if (all.length > 0) {
        const bounds = new maplibregl.LngLatBounds(
          [all[0]!.lng, all[0]!.lat],
          [all[0]!.lng, all[0]!.lat],
        );
        for (const point of all) bounds.extend([point.lng, point.lat]);
        map.fitBounds(bounds, { padding: 40, maxZoom: 11, duration: 600 });
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
        attributionControl: { compact: true },
      });
      map.addControl(new maplibregl.NavigationControl(), "top-right");
      map.addControl(new maplibregl.FullscreenControl(), "top-right");
      mapRef.current = map;

      map.on("load", () => {
        map.addSource("smart-path-deadhead", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "smart-path-deadhead-line",
          type: "line",
          source: "smart-path-deadhead",
          paint: {
            "line-color": "#0f766a",
            "line-width": 4,
            "line-dasharray": [2, 1.5],
            "line-opacity": 0.9,
          },
        });
        map.addSource("smart-path-route", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "smart-path-route-casing",
          type: "line",
          source: "smart-path-route",
          paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
        });
        map.addLayer({
          id: "smart-path-route-line",
          type: "line",
          source: "smart-path-route",
          paint: { "line-color": "#111111", "line-width": 5, "line-opacity": 0.85 },
        });
        draw();
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [draw]);

  // Latest props into the ref, then redraw - the ref write lives in
  // the effect, never in render (react-hooks/refs).
  useEffect(() => {
    dataRef.current = { geometry, stops, deadheadGeometry };
    draw();
  }, [geometry, stops, deadheadGeometry, draw]);

  const legendKinds = LEGEND_LABELS.filter(({ kind }) =>
    stops.some((stop) => stop.kind === kind),
  );

  return (
    <div>
      <div style={{ position: "relative" }}>
        <div
          ref={containerRef}
          role="img"
          aria-label="Map of the planned route with sleep, fuel, and food stops"
          style={{ width: "100%", height, borderRadius: "12px", overflow: "hidden" }}
        />
        {geometry.length === 0 && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              background: "rgba(17, 24, 39, 0.88)",
              color: "#fff",
              borderRadius: "9999px",
              padding: "8px 14px",
              fontSize: "13px",
              fontWeight: 600,
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            Run a check below — your route draws here.
          </div>
        )}
        {stops.length > 0 && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: "12px",
              bottom: "12px",
              background: "rgba(17, 24, 39, 0.88)",
              color: "#fff",
              borderRadius: "8px",
              padding: "6px 10px",
              fontSize: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              pointerEvents: "none",
            }}
          >
            {legendKinds.map(({ kind, label }) => (
              <span key={kind} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span
                  style={{
                    width: "10px",
                    height: "10px",
                    borderRadius: "9999px",
                    background: stops.find((stop) => stop.kind === kind)?.color,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                {label}
              </span>
            ))}
            {deadheadGeometry.length > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span
                  style={{
                    width: "16px",
                    borderTop: "3px dashed #0f766a",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                To pickup
              </span>
            )}
          </div>
        )}
      </div>
      <p>{caption}</p>
    </div>
  );
}
