// Shared route-check fixture for Drive tests (same data as drive.test.ts's own).
import { buildDrivePlan, type DrivePlanSnapshot } from "@/lib/drive";
import type { RouteCheckResponse } from "@/types/smart-path";

type LatLng = { lat: number; lng: number };


export const CHECKED_AT = new Date("2026-11-02T15:00:00.000Z");
export const T0 = CHECKED_AT.getTime();

export function linePoints(): LatLng[] {
  return Array.from({ length: 11 }, (_, i) => ({ lat: 28 + i * 0.5, lng: -81.7 }));
}

export function pointAt(fraction: number): LatLng {
  return { lat: 28 + fraction * 5, lng: -81.7 };
}

export function makeResult(overrides: Partial<RouteCheckResponse> = {}): RouteCheckResponse {
  const geometry = linePoints();
  const base: RouteCheckResponse = {
    load: { id: "load-1", origin: "Orlando, FL", destination: "Atlanta, GA", status: "assigned" },
    route: {
      provider: "valhalla",
      truckLegal: true,
      distanceMiles: 100,
      providerDurationMinutes: 120,
      geometry,
      originPoint: geometry[0]!,
      destinationPoint: geometry[geometry.length - 1]!,
      maneuvers: [
        { instruction: "Head north on I-75.", distanceMiles: 40, atFraction: 0.02 },
        { instruction: "Turn right onto Peachtree St.", distanceMiles: 2, atFraction: 0.9 },
      ],
    },
    clocks: {
      driveLeftMin: 600,
      windowLeftMin: 800,
      breakLeftMin: 400,
      weekLeftMin: 3000,
      fromLogs: true,
    },
    verdict: {
      status: "on_time",
      assumedDriveMinutes: 120,
      driveTimeBasis: "provider",
      legalLines: [],
      restedLines: [],
      lifeLines: [],
      paidLines: [],
      tradeoffLines: [],
      makeItDepartureAt: null,
      leaveStartByAt: null,
    },
    plan: {
      arrivalAt: "2026-11-02T17:00:00.000Z",
      totalElapsedMinutes: 120,
      breaks: [],
      rests: [],
      workout: null,
    },
    deadhead: null,
    fuel: {
      assumptions: {
        gallonsToBuy: 50,
        avgMpg: 6.5,
        valueOfTimeCentsPerHour: 2500,
        stopMinutes: 20,
        baselinePriceCents: null,
      },
      candidates: [
        {
          id: "fuel-1",
          name: "Pilot — Wildwood",
          lat: pointAt(0.3).lat,
          lng: -81.7,
          pricePerGallonCents: 389,
          source: "history",
          detourMiles: 0.4,
          pumpCostCents: 19450,
          detourCostCents: 300,
          effectiveCostCents: 19750,
          savingsVsBaselineCents: null,
          usedEstimate: false,
        },
      ],
      unavailableReason: null,
    },
    food: { mode: "grocery", groceryPlan: null, stops: [], suppressedByFast: [], lines: [], unavailableReason: null },
    warnings: [],
  };
  return { ...base, ...overrides };
}

export function makePlan(overrides: Partial<RouteCheckResponse> = {}): DrivePlanSnapshot {
  return buildDrivePlan(makeResult(overrides), CHECKED_AT);
}
