// NWS client tests - mocked HTTP only, no live calls. The request
// shape pinned here is the one live-verified 2026-11-03:
// api.weather.gov rejects a `limit` query parameter on /alerts/active
// with a 400 ("Query parameter \"limit\" is not recognized") - the
// exact production failure - and returns the full active set without
// it, paginating by cursor link only if it chooses to (see nws.ts).

import { describe, expect, it, vi } from "vitest";
import { fetchActiveAlerts, nextAlertsPageUrl } from "@/services/integrations/nws";

function alertFeature(event: string, zoneUrl: string) {
  return {
    properties: {
      event,
      severity: "Severe",
      headline: `${event} headline`,
      areaDesc: "Some County",
      affectedZones: [zoneUrl],
      expires: null,
    },
  };
}

function jsonPage(features: unknown[], next?: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => (next ? { features, pagination: { next } } : { features }),
  };
}

describe("fetchActiveAlerts", () => {
  it("requests the active alerts WITHOUT the rejected limit parameter", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonPage([alertFeature("Winter Storm Warning", "https://api.weather.gov/zones/forecast/FLZ162")]));

    const alerts = await fetchActiveAlerts(fetchFn as never);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.weather.gov/alerts/active?status=actual&message_type=alert");
    expect(url).not.toContain("limit");
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("TruckingResearchEngine");
    expect(alerts).toEqual([
      {
        event: "Winter Storm Warning",
        severity: "Severe",
        headline: "Winter Storm Warning headline",
        states: ["FL"],
        expires: null,
      },
    ]);
  });

  it("follows pagination.next cursor links and combines the pages", async () => {
    const nextUrl = "https://api.weather.gov/alerts/active?status=actual&message_type=alert&cursor=abc123";
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonPage([alertFeature("Hurricane Warning", "https://api.weather.gov/zones/forecast/FLZ162")], nextUrl),
      )
      .mockResolvedValueOnce(jsonPage([alertFeature("Tornado Warning", "https://api.weather.gov/zones/county/GAC013")]));

    const alerts = await fetchActiveAlerts(fetchFn as never);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]?.[0]).toBe(nextUrl);
    expect(alerts.map((a) => a.event)).toEqual(["Hurricane Warning", "Tornado Warning"]);
    expect(alerts[1]?.states).toEqual(["GA"]);
  });
});

describe("nextAlertsPageUrl", () => {
  it("returns null when the page carries no pagination", () => {
    expect(nextAlertsPageUrl({ features: [] })).toBeNull();
  });

  it("refuses to follow a pagination link off api.weather.gov", () => {
    expect(nextAlertsPageUrl({ pagination: { next: "https://evil.example.com/alerts?cursor=x" } })).toBeNull();
    expect(nextAlertsPageUrl({ pagination: { next: "https://api.weather.gov/alerts/active?cursor=x" } })).toBe(
      "https://api.weather.gov/alerts/active?cursor=x",
    );
  });
});
