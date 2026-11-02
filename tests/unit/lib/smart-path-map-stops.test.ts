// Piece 1 (P1-2): buildMapStops turns a route-check response into
// the map's stop model v2 - badges numbered within kind by rank /
// route order, popup lines carrying the same figures as the text
// lists, stacking in array order (fuel first, start last/on top).

import { describe, expect, it } from "vitest";
import { buildMapStops } from "@/lib/smart-path-map-stops";
import type { RouteCheckResponse } from "@/types/smart-path";

function makeResult(): RouteCheckResponse {
  return {
    load: { id: "load-1", origin: "Melbourne, FL", destination: "Atlanta, GA", status: "confirmed" },
    route: {
      provider: "OpenRouteService driving-hgv",
      truckLegal: true,
      distanceMiles: 460.5,
      providerDurationMinutes: 512,
      geometry: [
        { lat: 28.08, lng: -80.6 },
        { lat: 33.75, lng: -84.39 },
      ],
      originPoint: { lat: 28.08, lng: -80.6 },
      destinationPoint: { lat: 33.75, lng: -84.39 },
    },
    verdict: {
      status: "on_time",
      assumedDriveMinutes: 540,
      driveTimeBasis: "truck profile speed (55 mph governed)",
      legalLines: [],
      restedLines: [],
      lifeLines: [],
      paidLines: [],
      tradeoffLines: [],
      makeItDepartureAt: null,
      leaveStartByAt: null,
    },
    plan: {
      arrivalAt: "2026-11-02T23:30:00.000Z",
      totalElapsedMinutes: 690,
      breaks: [],
      rests: [
        {
          startAt: "2026-11-02T18:00:00.000Z",
          endAt: "2026-11-03T04:00:00.000Z",
          distanceMilesFromOrigin: 210,
          fractionOfRoute: 0.45,
          startHourEastern: 13,
          point: { lat: 31, lng: -82 },
        },
        {
          startAt: "2026-11-03T20:00:00.000Z",
          endAt: "2026-11-04T06:00:00.000Z",
          distanceMilesFromOrigin: 430,
          fractionOfRoute: 0.9,
          startHourEastern: 15,
          point: { lat: 33, lng: -84 },
        },
      ],
      workout: {
        placed: true,
        startAt: "2026-11-02T16:00:00.000Z",
        durationMinutes: 60,
        placeName: "Planet Fitness",
        placeKind: "gym",
        point: { lat: 30.5, lng: -81.5 },
        note: "Workout fits at your break.",
      },
    },
    deadhead: {
      startLabel: "Melbourne, FL",
      startPoint: { lat: 28.1, lng: -80.7 },
      distanceMiles: 42,
      providerDurationMinutes: 55,
      provider: "OpenRouteService driving-hgv",
      truckLegal: true,
      geometry: [
        { lat: 28.1, lng: -80.7 },
        { lat: 28.08, lng: -80.6 },
      ],
      leaveByAt: "2026-11-02T09:00:00.000Z",
      pickupArrivalAt: "2026-11-02T10:05:00.000Z",
      waitMinutesAtPickup: 25,
    },
    fuel: {
      assumptions: {
        gallonsToBuy: 100,
        avgMpg: 6.5,
        valueOfTimeCentsPerHour: 2500,
        stopMinutes: 30,
        baselinePriceCents: 399,
      },
      candidates: [
        {
          id: "history:Pilot, I-75",
          name: "Pilot, I-75",
          lat: 32,
          lng: -83,
          pricePerGallonCents: 389,
          estimatedPricePerGallonCents: null,
          estimateLabel: null,
          usedEstimate: false,
          source: "history",
          detourMiles: 0,
          pumpCostCents: 38900,
          detourCostCents: 1250,
          effectiveCostCents: 40150,
          savingsVsBaselineCents: -250,
        },
        {
          id: "map:Loves, I-95",
          name: "Love's, I-95",
          lat: 30,
          lng: -81,
          pricePerGallonCents: null,
          estimatedPricePerGallonCents: 392,
          estimateLabel: "EIA U.S. average, week of Oct 26",
          usedEstimate: true,
          source: "map",
          detourMiles: 2.4,
          pumpCostCents: null,
          detourCostCents: 1800,
          effectiveCostCents: 41000,
          savingsVsBaselineCents: null,
        },
        {
          id: "map:NoPrice Truck Stop",
          name: "NoPrice Truck Stop",
          lat: 29,
          lng: -80.9,
          pricePerGallonCents: null,
          estimatedPricePerGallonCents: null,
          estimateLabel: null,
          usedEstimate: false,
          source: "map",
          detourMiles: 1.2,
          pumpCostCents: null,
          detourCostCents: 900,
          effectiveCostCents: null,
          savingsVsBaselineCents: null,
        },
        {
          id: "map:Fourth Station",
          name: "Fourth Station",
          lat: 28.5,
          lng: -80.8,
          pricePerGallonCents: null,
          estimatedPricePerGallonCents: null,
          estimateLabel: null,
          usedEstimate: false,
          source: "map",
          detourMiles: 3.1,
          pumpCostCents: null,
          detourCostCents: 1100,
          effectiveCostCents: null,
          savingsVsBaselineCents: null,
        },
      ],
      unavailableReason: null,
    },
    food: {
      mode: "grocery",
      groceryPlan: null,
      stops: [
        {
          id: "food-1",
          name: "Publix",
          detourMiles: 1.5,
          arrivalAt: "2026-11-02T15:00:00.000Z",
          lat: 30.2,
          lng: -81.2,
        },
      ],
      suppressedByFast: [],
      lines: [],
      unavailableReason: null,
    },
    warnings: [],
  };
}

describe("buildMapStops", () => {
  it("numbers fuel badges F1..F3 in rank order and caps at three", () => {
    const stops = buildMapStops(makeResult());
    const fuel = stops.filter((s) => s.kind === "fuel");
    expect(fuel.map((s) => s.badge)).toEqual(["F1", "F2", "F3"]);
    expect(fuel.map((s) => s.id)).toEqual([
      "history:Pilot, I-75",
      "map:Loves, I-95",
      "map:NoPrice Truck Stop",
    ]);
  });

  it("stacks fuel before origin, and orders kinds fuel/food/rest/workout/origin/destination/start", () => {
    const stops = buildMapStops(makeResult());
    const fuelIndex = stops.findIndex((s) => s.kind === "fuel");
    const originIndex = stops.findIndex((s) => s.kind === "origin");
    expect(fuelIndex).toBeGreaterThanOrEqual(0);
    expect(fuelIndex).toBeLessThan(originIndex);
    expect(stops.map((s) => s.kind)).toEqual([
      "fuel",
      "fuel",
      "fuel",
      "food",
      "rest",
      "rest",
      "workout",
      "origin",
      "destination",
      "start",
    ]);
  });

  it("renders the logged price line with the fuel-log provenance", () => {
    const stops = buildMapStops(makeResult());
    const logged = stops.find((s) => s.id === "history:Pilot, I-75");
    expect(logged?.lines[0]).toContain("(from your fuel log)");
    expect(logged?.lines[0]).toContain("$3.89/gal");
    expect(logged?.lines[2]).toBe("effective cost $401.50");
  });

  it("renders the estimate price line labeled as an estimate", () => {
    const stops = buildMapStops(makeResult());
    const estimate = stops.find((s) => s.id === "map:Loves, I-95");
    expect(estimate?.lines[0]).toContain("est. —");
    expect(estimate?.lines[0]).toContain("EIA U.S. average, week of Oct 26");
  });

  it("renders an unknown price honestly and falls back to the detour cost line", () => {
    const stops = buildMapStops(makeResult());
    const unknown = stops.find((s) => s.id === "map:NoPrice Truck Stop");
    expect(unknown?.lines[0]).toBe("price unknown");
    expect(unknown?.lines[2]).toBe("detour cost $9.00");
  });

  it("builds coordinate-based Google Maps URLs", () => {
    const stops = buildMapStops(makeResult());
    const fuel = stops.find((s) => s.id === "history:Pilot, I-75");
    expect(fuel?.mapsUrl).toBe("https://www.google.com/maps/search/?api=1&query=32,-83");
    const origin = stops.find((s) => s.kind === "origin");
    expect(origin?.mapsUrl).toContain("28.08,-80.6");
    for (const stop of stops) {
      expect(stop.mapsUrl).toContain(`${stop.point.lat},${stop.point.lng}`);
    }
  });

  it("numbers rests S1/S2 in route order with Sleep stop titles", () => {
    const stops = buildMapStops(makeResult());
    const rests = stops.filter((s) => s.kind === "rest");
    expect(rests.map((s) => s.badge)).toEqual(["S1", "S2"]);
    expect(rests.map((s) => s.id)).toEqual(["rest-0", "rest-1"]);
    expect(rests[0]?.title).toBe("Sleep stop");
    expect(rests[0]?.lines[0]).toBe("Near mile 210");
  });

  it("adds the START stop when a deadhead leg is present", () => {
    const stops = buildMapStops(makeResult());
    const start = stops.find((s) => s.kind === "start");
    expect(start?.badge).toBe("START");
    expect(start?.title).toBe("Start — Melbourne, FL");
    expect(start?.point).toEqual({ lat: 28.1, lng: -80.7 });
  });

  it("omits the START stop when there is no deadhead leg", () => {
    const result = makeResult();
    result.deadhead = null;
    const stops = buildMapStops(result);
    expect(stops.some((s) => s.kind === "start")).toBe(false);
  });

  it("adds the workout stop when the workout is placed with a point", () => {
    const stops = buildMapStops(makeResult(), { workoutSetting: "gym_preferred" });
    const workout = stops.find((s) => s.kind === "workout");
    expect(workout?.badge).toBe("W1");
    expect(workout?.title).toBe("Planet Fitness");
    expect(workout?.lines[0]).toBe("Workout — 60 min");
  });

  it("omits the workout stop when placed without a point", () => {
    const result = makeResult();
    result.plan!.workout!.point = null;
    const stops = buildMapStops(result);
    expect(stops.some((s) => s.kind === "workout")).toBe(false);
  });

  it("omits the workout stop when the workout was not placed", () => {
    const result = makeResult();
    result.plan!.workout!.placed = false;
    const stops = buildMapStops(result);
    expect(stops.some((s) => s.kind === "workout")).toBe(false);
  });

  it("adds the bodyweight line only for a gym preference served by a non-gym spot", () => {
    const result = makeResult();
    result.plan!.workout!.placeKind = "rest_area";
    result.plan!.workout!.placeName = "Rest area";

    const preferred = buildMapStops(result, { workoutSetting: "gym_preferred" });
    const workoutPreferred = preferred.find((s) => s.kind === "workout");
    expect(workoutPreferred?.lines.some((line) => line.includes("bodyweight spot"))).toBe(true);

    const anyStop = buildMapStops(result, { workoutSetting: "any_safe_stop" });
    const workoutAny = anyStop.find((s) => s.kind === "workout");
    expect(workoutAny?.lines.some((line) => line.includes("bodyweight spot"))).toBe(false);
  });

  it("adds no bodyweight line when a gym was actually placed", () => {
    const stops = buildMapStops(makeResult(), { workoutSetting: "gym_preferred" });
    const workout = stops.find((s) => s.kind === "workout");
    expect(workout?.lines.some((line) => line.includes("bodyweight spot"))).toBe(false);
  });
});
