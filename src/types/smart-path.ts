// Smart Path v1 response shape (docs/design/driver-mvp.md §8.3,
// docs/api-contracts.md). Mirrors what POST /api/v1/smart-path/
// route-check returns; the page renders it without re-deriving any
// number - every figure traces to the lib computation or a provider.

import type { LatLng, RouteCheckStatus, PlannedBreak, PlannedRest } from "@/lib/smart-path";
import type { FoodMode, GroceryPlan, RankedFuelCandidate } from "@/lib/smart-path-stops";

export interface RouteCheckResponse {
  load: {
    id: string;
    origin: string;
    destination: string;
    status: string;
  };
  route: {
    provider: string;
    /** False claims are the failure mode this feature exists to avoid: geometry is a car route in v1. */
    truckLegal: false;
    distanceMiles: number;
    providerDurationMinutes: number;
    geometry: LatLng[];
    originPoint: LatLng;
    destinationPoint: LatLng;
  };
  verdict: {
    status: RouteCheckStatus;
    assumedDriveMinutes: number;
    driveTimeBasis: string;
    legalLines: string[];
    restedLines: string[];
    paidLines: string[];
    tradeoffLines: string[];
    makeItDepartureAt: string | null;
  };
  plan: {
    arrivalAt: string | null;
    totalElapsedMinutes: number;
    breaks: PlannedBreak[];
    rests: (PlannedRest & { point: LatLng | null })[];
  } | null;
  fuel: {
    assumptions: {
      gallonsToBuy: number;
      avgMpg: number;
      valueOfTimeCentsPerHour: number;
      stopMinutes: number;
      baselinePriceCents: number | null;
    };
    candidates: RankedFuelCandidate[];
    unavailableReason: string | null;
  };
  food: {
    mode: FoodMode;
    groceryPlan: GroceryPlan | null;
    stops: { id: string; name: string; detourMiles: number; arrivalAt: string; lat: number; lng: number }[];
    suppressedByFast: string[];
    lines: string[];
    unavailableReason: string | null;
  };
  warnings: string[];
}
