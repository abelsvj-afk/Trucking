"use client";

// Truck stops, rest areas, fuel and truck parking along a route, for
// HOME's map (owner 2026-11-19: everything on the Drive screen must be
// on Home too). Same free OSM source and endpoint the Drive screen uses;
// asked once per route (a reroute is a new route), and quietly empty when
// the service is down — never invented stops.

import { useEffect, useState } from "react";
import type { LatLng } from "@/lib/smart-path";
import type { TruckPoisResponse } from "@/types/smart-path";

export type RoutePoi = TruckPoisResponse["items"][number];

function routeKey(geometry: LatLng[]): string {
  if (geometry.length < 2) return "";
  const a = geometry[0]!;
  const b = geometry[geometry.length - 1]!;
  return `${geometry.length}:${a.lat.toFixed(4)},${a.lng.toFixed(4)}:${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
}

function thin(points: LatLng[], max: number): LatLng[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

export function useRoutePois(geometry: LatLng[] | null, totalMiles: number | null): RoutePoi[] {
  const [state, setState] = useState<{ key: string; items: RoutePoi[] }>({ key: "", items: [] });
  const key = geometry && totalMiles ? routeKey(geometry) : "";
  useEffect(() => {
    if (!key || !geometry || !totalMiles) return;
    let cancelled = false;
    fetch("/api/v1/smart-path/truck-pois", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The endpoint takes up to 2,000 points: a long route is thinned evenly (ends kept).
      body: JSON.stringify({ geometry: thin(geometry, 2000), totalMiles: Math.round(totalMiles * 10) / 10 }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<TruckPoisResponse>) : null))
      .then((body) => {
        // An unexpected answer is treated as "no stops", never a crash.
        if (!cancelled && body) setState({ key, items: Array.isArray(body.items) ? body.items : [] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // The geometry array identity changes on every render; the key is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state.items : [];
}
