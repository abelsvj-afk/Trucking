import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  clearTomTomTrafficCache,
  corridorBboxes,
  fetchTomTomIncidents,
  TomTomTrafficError,
} from "@/services/integrations/tomtom-traffic";

beforeEach(() => clearTomTomTrafficCache());

// Straight route north, ~1.45 deg lat per 100 miles.
const line = (miles: number) =>
  Array.from({ length: miles + 1 }, (_, i) => ({ lat: 35 + i * 0.01449, lng: -90 }));

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

const tomtomBody = {
  incidents: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-90, 35.6] },
      properties: {
        id: "inc-a",
        iconCategory: 6,
        magnitudeOfDelay: 3,
        delay: 1500,
        events: [{ description: "Queue ahead" }],
        startTime: "2026-11-17T11:00:00Z",
        endTime: "2026-11-17T13:00:00Z",
        from: "Exit 10",
        to: "Exit 12",
        length: 3000,
        roadNumbers: ["I-55"],
      },
    },
    {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [-90, 36.0],
          [-90, 36.1],
        ],
      },
      properties: {
        id: "inc-b",
        iconCategory: 1,
        magnitudeOfDelay: 2,
        delay: 600,
        events: [{ description: "Accident" }],
        roadNumbers: [],
      },
    },
  ],
};

describe("corridorBboxes", () => {
  it("chunks a long route into ~60-mile boxes, nearest first", () => {
    const boxes = corridorBboxes(line(130));
    expect(boxes).toHaveLength(3);
    expect(boxes[0]!.minLat).toBeLessThan(boxes[1]!.minLat);
    expect(boxes[2]!.maxLat).toBeGreaterThan(boxes[1]!.maxLat);
  });
  it("returns one box for a short route, with margin", () => {
    const boxes = corridorBboxes(line(20));
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.minLat).toBeLessThan(35);
    expect(boxes[0]!.maxLat).toBeGreaterThan(35 + 20 * 0.01449);
  });
  it("returns nothing for no points", () => {
    expect(corridorBboxes([])).toEqual([]);
  });
});

describe("fetchTomTomIncidents", () => {
  it("maps the TomTom shape onto TrafficIncident, LineString included", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => jsonResponse(tomtomBody));
    const incidents = await fetchTomTomIncidents({ fetchFn, apiKey: "k", points: line(20) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(incidents).toHaveLength(2);
    expect(incidents[0]).toMatchObject({
      id: "inc-a",
      iconCategory: 6,
      magnitude: 3,
      delaySeconds: 1500,
      description: "Queue ahead",
      from: "Exit 10",
      to: "Exit 12",
      lengthMeters: 3000,
      roadNumbers: ["I-55"],
    });
    expect(incidents[0]!.points).toEqual([{ lat: 35.6, lng: -90 }]);
    expect(incidents[1]!.points).toHaveLength(2);
    expect(incidents[1]!.delaySeconds).toBe(600);
    const url = String(fetchFn.mock.calls[0]![0]);
    expect(url).toContain("incidentDetails");
    expect(url).toContain("timeValidityFilter=present");
    expect(url).toContain("bbox=");
  });
  it("dedupes an incident reported in two overlapping boxes", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(tomtomBody));
    const incidents = await fetchTomTomIncidents({ fetchFn, apiKey: "k", points: line(130) });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(incidents).toHaveLength(2);
  });
  it("caps at 10 bbox calls on a very long route", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ incidents: [] }));
    await fetchTomTomIncidents({ fetchFn, apiKey: "k", points: line(800) });
    expect(fetchFn).toHaveBeenCalledTimes(10);
  });
  it("serves the second identical call from the 2-minute cache", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(tomtomBody));
    const first = await fetchTomTomIncidents({ fetchFn, apiKey: "k", points: line(20) });
    const second = await fetchTomTomIncidents({ fetchFn, apiKey: "k", points: line(20) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
  it("throws a TomTomTrafficError on HTTP failure, without inventing incidents", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "nope" }, false, 500));
    await expect(fetchTomTomIncidents({ fetchFn, apiKey: "k", points: line(20) })).rejects.toBeInstanceOf(
      TomTomTrafficError,
    );
  });
  it("throws when no key is given", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(tomtomBody));
    await expect(fetchTomTomIncidents({ fetchFn, apiKey: "", points: line(20) })).rejects.toBeInstanceOf(
      TomTomTrafficError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("returns nothing for no points", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(tomtomBody));
    expect(await fetchTomTomIncidents({ fetchFn, apiKey: "k", points: [] })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
