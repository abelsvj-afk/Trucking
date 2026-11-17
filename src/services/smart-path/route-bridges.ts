// Smart Path live awareness (owner 2026-11-17): the bridges
// section of a route check. Asks Overpass for bridges with a posted
// clearance on the corridor and judges each against his truck's
// height. Never throws — failure degrades the section to
// "unavailable", never to a guessed clearance.

import type { LatLng } from "@/lib/smart-path";
import { bridgeItems, type BridgeFeature, type BridgeItem } from "@/lib/smart-path-bridges";
import { fetchBridgeFeatures } from "@/services/integrations/overpass-bridges";

export interface BridgesFetchers {
  features: (points: LatLng[]) => Promise<BridgeFeature[]>;
}

export const defaultBridgesFetchers: BridgesFetchers = {
  features: (points) => fetchBridgeFeatures({ points }),
};

export interface BridgesSection {
  status: "ok" | "unavailable";
  items: BridgeItem[];
  notes: string[];
  asOf: string;
}

export interface BridgesCorridorPoint {
  mile: number;
  lat: number;
  lng: number;
  etaAt: string | null;
}

export interface BuildBridgesSectionInput {
  corridor: BridgesCorridorPoint[];
  /** His truck's height in inches, from the truck profile; null when the app doesn't know it. */
  truckHeightIn: number | null;
  fetchers?: BridgesFetchers;
  now?: Date;
}

export async function buildBridgesSection(input: BuildBridgesSectionInput): Promise<BridgesSection> {
  const now = input.now ?? new Date();
  const asOf = now.toISOString();
  const fetchers = input.fetchers ?? defaultBridgesFetchers;
  let features: BridgeFeature[];
  try {
    features = await fetchers.features(input.corridor.map((c) => ({ lat: c.lat, lng: c.lng })));
  } catch {
    return {
      status: "unavailable",
      items: [],
      notes: ["Bridge clearances couldn't be checked right now — nothing is claimed about bridges on this route."],
      asOf,
    };
  }
  const items = bridgeItems(features, input.corridor, input.truckHeightIn);
  const notes: string[] = [
    items.length === 0
      ? "Checked the map for bridges with a posted clearance — none found on your route."
      : `Checked the map for bridges with a posted clearance — ${items.length} on your route.`,
    "A bridge with no posted clearance in the map isn't listed and isn't a pass — check the signs and your truck's own nav.",
  ];
  if (input.truckHeightIn === null) {
    notes.push("Your truck height isn't in the app, so clearances can't be judged against it — add it in Settings.");
  }
  return { status: "ok", items, notes, asOf };
}
