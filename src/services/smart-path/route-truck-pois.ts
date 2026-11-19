// Truck POIs along the route (audit-fix B7, 2026-11-18): maps the
// map records from Overpass onto the route, in miles, so the drive
// screen can show each stop's LIVE distance as the truck moves.
// Never throws — failure degrades the section to "unavailable",
// never to invented stops.

import type { LatLng } from "@/lib/smart-path";
import { routeProgress } from "@/lib/route-progress";
import type { TruckPoiFeature, TruckPoiKind } from "@/services/integrations/overpass-truck-pois";
import { fetchTruckPoiFeatures } from "@/services/integrations/overpass-truck-pois";

export type { TruckPoiKind };

export interface TruckPoiItem {
  id: string;
  kind: TruckPoiKind;
  name: string | null;
  /** Miles along the route geometry, from its start. */
  mile: number;
  point: LatLng;
}

export interface TruckPoisFetchers {
  features: (points: LatLng[]) => Promise<TruckPoiFeature[]>;
}

export const defaultTruckPoisFetchers: TruckPoisFetchers = {
  features: (points) => fetchTruckPoiFeatures({ points }),
};

export interface TruckPoisSection {
  status: "ok" | "unavailable";
  items: TruckPoiItem[];
  notes: string[];
  asOf: string;
}

/**
 * Maps POI features onto the route: the projection onto the line is
 * where he meets it, in miles. A stop the projection cannot put on
 * the line (farther than the route's own on-route band) is not his
 * stop — it is a detour, and it is dropped rather than shown with a
 * distance that pretends otherwise. Sorted by mile.
 */
export function truckPoiItems(features: TruckPoiFeature[], geometry: LatLng[]): TruckPoiItem[] {
  if (geometry.length < 2) return [];
  const items: TruckPoiItem[] = [];
  for (const f of features) {
    const progress = routeProgress(f.point, geometry);
    if (!progress || !progress.onRoute || progress.milesDone === null) continue;
    items.push({ id: f.id, kind: f.kind, name: f.name, mile: progress.milesDone, point: f.point });
  }
  items.sort((a, b) => a.mile - b.mile);
  return items;
}

export interface BuildTruckPoisSectionInput {
  geometry: LatLng[];
  /** Miles of the geometry sent; items past it are not on this run. */
  totalMiles: number;
  fetchers?: TruckPoisFetchers;
  now?: Date;
}

export async function buildTruckPoisSection(
  input: BuildTruckPoisSectionInput,
): Promise<TruckPoisSection> {
  const now = input.now ?? new Date();
  const asOf = now.toISOString();
  const fetchers = input.fetchers ?? defaultTruckPoisFetchers;
  let features: TruckPoiFeature[];
  try {
    features = await fetchers.features(input.geometry);
  } catch {
    return {
      status: "unavailable",
      items: [],
      notes: ["Truck stops couldn't be checked right now — nothing is claimed about stops on this route."],
      asOf,
    };
  }
  const items = truckPoiItems(features, input.geometry).filter((i) => i.mile <= input.totalMiles);
  const notes: string[] = [
    items.length === 0
      ? "Checked the map for truck stops, fuel, rest areas, and truck parking — none found on your route."
      : `Checked the map for truck stops, fuel, rest areas, and truck parking — ${items.length} on your route.`,
    "A stop listed here is a map record, not a promise of parking, diesel, or hours — the signs and the stop itself are the final word.",
  ];
  return { status: "ok", items, notes, asOf };
}
