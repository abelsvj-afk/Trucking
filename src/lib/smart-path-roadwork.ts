// Smart Path intelligence, Phase 3 (docs/design/smart-path-intelligence.md §3): parse
// a WZDx work-zone GeoJSON feed (USDOT Work Zone Data Exchange; untrusted external
// data, Zod-validated and tolerant of optional fields) and keep only events near the
// route that are active when he gets there. Pure. An event's text is displayed, never
// interpreted. A reduced-height/width/weight restriction his truck profile exceeds is
// a warning; nothing here says a road is open or blocked.

import { z } from "zod";
import { distanceToRouteMiles, type LatLng } from "./smart-path";

export const NEAR_ROUTE_MILES = 5;

const featureSchema = z.object({
  properties: z.object({
    core_details: z.object({
      event_type: z.string().optional(),
      road_names: z.array(z.string()).optional(),
      direction: z.string().optional(),
      description: z.string().nullable().optional(),
    }).optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    vehicle_impact: z.string().nullable().optional(),
    restrictions: z
      .array(z.object({ type: z.string(), value: z.number().nullable().optional(), unit: z.string().nullable().optional() }))
      .nullable()
      .optional(),
  }),
  geometry: z.object({ type: z.string(), coordinates: z.unknown() }).nullable().optional(),
});
const feedSchema = z.object({ features: z.array(z.unknown()) });

export interface RoadEvent {
  roads: string[];
  direction: string | null;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  impact: string | null;
  restrictions: { type: string; value: number | null; unit: string | null }[];
  point: LatLng;
}

function firstPoint(coords: unknown): LatLng | null {
  let c: unknown = coords;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") return { lng: c[0], lat: c[1] };
  return null;
}

/** Parses a feed; unreadable features are skipped and counted, an unreadable feed throws. */
export function parseWzdx(json: unknown): { events: RoadEvent[]; skipped: number } {
  const feed = feedSchema.safeParse(json);
  if (!feed.success) throw new Error("Work-zone feed didn't match the expected shape.");
  const events: RoadEvent[] = [];
  let skipped = 0;
  for (const raw of feed.data.features) {
    const f = featureSchema.safeParse(raw);
    const point = f.success ? firstPoint(f.data.geometry?.coordinates) : null;
    if (!f.success || !point) {
      skipped += 1;
      continue;
    }
    const p = f.data.properties;
    events.push({
      roads: p.core_details?.road_names ?? [],
      direction: p.core_details?.direction ?? null,
      description: p.core_details?.description ?? null,
      startsAt: p.start_date ?? null,
      endsAt: p.end_date ?? null,
      impact: p.vehicle_impact ?? null,
      restrictions: (p.restrictions ?? []).map((r) => ({ type: r.type, value: r.value ?? null, unit: r.unit ?? null })),
      point,
    });
  }
  return { events, skipped };
}

export interface RoadWorkItem {
  mile: number;
  etaAt: string;
  text: string;
  /** A posted restriction his truck profile exceeds. */
  exceedsTruck: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

const toInches = (value: number, unit: string | null): number | null =>
  unit === "foot" || unit === "feet" ? value * 12 : unit === "inch" || unit === "inches" || unit === null ? value : null;

export function roadWorkItems(
  events: RoadEvent[],
  corridor: { mile: number; lat: number; lng: number; etaAt: string | null }[],
  truckHeightIn: number | null,
): RoadWorkItem[] {
  const geometry = corridor.map((c) => ({ lat: c.lat, lng: c.lng }));
  const items: RoadWorkItem[] = [];
  for (const ev of events) {
    if (corridor.length === 0 || distanceToRouteMiles(ev.point, geometry) > NEAR_ROUTE_MILES) continue;
    // Nearest corridor point = where he meets it; judge "active" at HIS time there.
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    corridor.forEach((c, i) => {
      const d = distanceToRouteMiles(ev.point, [{ lat: c.lat, lng: c.lng }]);
      if (d < bestD) { bestD = d; best = i; }
    });
    const at = corridor[best]!;
    if (!at.etaAt) continue; // cannot say it is active when he arrives
    const etaMs = Date.parse(at.etaAt);
    const start = ev.startsAt ? Date.parse(ev.startsAt) : Number.NEGATIVE_INFINITY;
    const end = ev.endsAt ? Date.parse(ev.endsAt) : Number.POSITIVE_INFINITY;
    if ((!Number.isNaN(start) && start > etaMs) || (!Number.isNaN(end) && end < etaMs)) continue;
    const height = ev.restrictions.find((r) => /height/i.test(r.type) && r.value !== null);
    const limitIn = height ? toInches(height.value as number, height.unit) : null;
    const exceeds = limitIn !== null && truckHeightIn !== null && truckHeightIn > limitIn;
    const roads = ev.roads.join(", ") || "a road near the route";
    items.push({
      mile: at.mile,
      etaAt: at.etaAt,
      exceedsTruck: exceeds,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      text: `${roads}${ev.direction ? ` (${ev.direction})` : ""}: ${ev.description ?? "work zone"}${ev.impact ? ` - ${ev.impact.replace(/-/g, " ")}` : ""}${exceeds ? ` - posted height limit is under your truck profile` : ""}.`,
    });
  }
  return items.sort((a, b) => a.mile - b.mile);
}
