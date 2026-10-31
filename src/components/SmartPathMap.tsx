"use client";

// Smart Path v1 (docs/design/driver-mvp.md §8.1). The native in-app
// map: MapLibre GL JS over OpenStreetMap raster tiles - keyless, so
// nothing about an API key can block it. The engine is borrowed; the
// layers (route, sleep stop, fuel/food candidates) are this app's.
//
// The style below is the one place a future tile provider swaps in.
// Limits are stated in the design doc: OSM tiles are fair-use at this
// scale, there is no traffic layer, and the route line is a car route
// in v1 - the page says so next to the map, not just here.

import { useCallback, useEffect, useRef } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LatLng } from "@/lib/smart-path";

export interface SmartPathMapStop {
  point: LatLng;
  label: string;
  color: string;
}

interface SmartPathMapProps {
  geometry: LatLng[];
  stops: SmartPathMapStop[];
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

export default function SmartPathMap({ geometry, stops }: SmartPathMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const dataRef = useRef({ geometry, stops });

  const draw = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("smart-path-route")) return;
    void (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      const { geometry: geo, stops: currentStops } = dataRef.current;

      const source = map.getSource("smart-path-route") as
        | { setData: (data: unknown) => void }
        | undefined;
      source?.setData({
        type: "FeatureCollection",
        features:
          geo.length > 1
            ? [
                {
                  type: "Feature",
                  properties: {},
                  geometry: {
                    type: "LineString",
                    coordinates: geo.map((p) => [p.lng, p.lat]),
                  },
                },
              ]
            : [],
      });

      for (const marker of markersRef.current) marker.remove();
      markersRef.current = currentStops.map((stop) => {
        const el = document.createElement("div");
        el.textContent = stop.label;
        el.style.cssText =
          `background:${stop.color};color:#fff;border-radius:9999px;` +
          "min-width:28px;height:28px;display:flex;align-items:center;justify-content:center;" +
          "font-size:13px;font-weight:700;padding:0 6px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)";
        return new maplibregl.Marker({ element: el })
          .setLngLat([stop.point.lng, stop.point.lat])
          .addTo(map);
      });

      const all = [...geo, ...currentStops.map((s) => s.point)];
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
      mapRef.current = map;

      map.on("load", () => {
        map.addSource("smart-path-route", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "smart-path-route-line",
          type: "line",
          source: "smart-path-route",
          paint: { "line-color": "#2563eb", "line-width": 5, "line-opacity": 0.85 },
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
    dataRef.current = { geometry, stops };
    draw();
  }, [geometry, stops, draw]);

  return (
    <div>
      <div
        ref={containerRef}
        role="img"
        aria-label="Map of the planned route with sleep, fuel, and food stops"
        style={{ width: "100%", height: "340px", borderRadius: "12px", overflow: "hidden" }}
      />
      <p>Map © OpenStreetMap contributors. Route line is a standard car route in this version — not checked against truck restrictions.</p>
    </div>
  );
}
