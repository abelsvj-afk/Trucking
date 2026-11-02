// National Weather Service source for the Deep Research Engine
// (2026-11-02 design, D-3): api.weather.gov active alerts - free,
// keyless, official. NWS asks callers to send a User-Agent; we send
// an honest one. Response strictly Zod-validated. Zone IDs in
// affectedZones carry the state code (e.g. ".../zones/forecast/FLZ162"
// -> FL), which is how an alert's states are derived - county names
// in areaDesc are never parsed for geography.

import { z } from "zod";

const nwsResponseSchema = z.object({
  features: z.array(
    z.object({
      properties: z.object({
        event: z.string(),
        severity: z.string().optional(),
        headline: z.string().nullable().optional(),
        areaDesc: z.string().optional(),
        affectedZones: z.array(z.string()).optional(),
        expires: z.string().nullable().optional(),
      }),
    }),
  ),
});

export interface NwsAlert {
  event: string;
  severity: string | null;
  headline: string | null;
  states: string[];
  expires: string | null;
}

export function statesFromZones(zones: string[] | undefined): string[] {
  const states = new Set<string>();
  for (const zone of zones ?? []) {
    // Forecast/fire zones look like FLZ162; county zones like FLC123 -
    // both lead with the two-letter state code.
    const match = zone.match(/([A-Z]{2})[ZC]\d+/);
    if (match?.[1]) states.add(match[1]);
  }
  return [...states];
}

/** Parses the NWS alerts payload into normalized alerts. Pure - unit-tested. */
export function parseNwsAlerts(json: unknown): NwsAlert[] {
  const parsed = nwsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`NWS response didn't match the expected shape: ${parsed.error.message}`);
  }
  return parsed.data.features.map((f) => ({
    event: f.properties.event,
    severity: f.properties.severity ?? null,
    headline: f.properties.headline ?? null,
    states: statesFromZones(f.properties.affectedZones),
    expires: f.properties.expires ?? null,
  }));
}

export async function fetchActiveAlerts(fetchFn: typeof fetch = fetch): Promise<NwsAlert[]> {
  const url = "https://api.weather.gov/alerts/active?status=actual&message_type=alert&limit=200";
  const res = await fetchFn(url, {
    headers: {
      "User-Agent": "TruckingResearchEngine/1.0 (owner-operator research bot)",
      Accept: "application/geo+json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`NWS request failed: ${res.status} ${res.statusText}`);
  return parseNwsAlerts(await res.json());
}
