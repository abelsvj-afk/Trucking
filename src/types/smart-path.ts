// Smart Path v1 response shape (docs/design/driver-mvp.md §8.3,
// docs/api-contracts.md). Mirrors what POST /api/v1/smart-path/
// route-check returns; the page renders it without re-deriving any
// number - every figure traces to the lib computation or a provider.

import type {
  ClockState,
  LatLng,
  RouteCheckStatus,
  PlannedBreak,
  PlannedRest,
  WorkoutOutcome,
} from "@/lib/smart-path";
import type { FoodMode, GroceryPlan, RankedFuelCandidate } from "@/lib/smart-path-stops";
import type { RouteManeuver } from "@/services/integrations/routing";

export interface RouteCheckResponse {
  load: {
    id: string;
    origin: string;
    destination: string;
    status: string;
  };
  route: {
    provider: string;
    /**
     * True only when a truck-aware engine (ORS driving-hgv or
     * Valhalla truck costing) actually served the route (§8.5);
     * false when the chain fell back to the OSRM car profile. Even
     * true means "checked against the restrictions recorded in
     * OpenStreetMap data" - OSM coverage is incomplete, never a
     * guarantee. False claims are the failure mode this feature
     * exists to avoid.
     */
    truckLegal: boolean;
    distanceMiles: number;
    providerDurationMinutes: number;
    geometry: LatLng[];
    originPoint: LatLng;
    destinationPoint: LatLng;
    /**
     * Drive Mode D1 (G-6 enabler): turn prompts from the serving
     * provider, normalized. Optional - a plan without them still
     * Drives with next-stop guidance only.
     */
    maneuvers?: RouteManeuver[];
  };
  /**
   * Drive Mode D1: the planning clocks this check ran against
   * (from his app logs, or fresh when none exist - clocksFromHos
   * says which via fromLogs). Drive projects its drive-time-left
   * chip and HOS cliff warnings from these, labeled projections.
   * The ELD remains the legal record (F-014).
   */
  clocks?: ClockState;
  verdict: {
    status: RouteCheckStatus;
    assumedDriveMinutes: number;
    driveTimeBasis: string;
    legalLines: string[];
    restedLines: string[];
    lifeLines: string[];
    paidLines: string[];
    tradeoffLines: string[];
    makeItDepartureAt: string | null;
    /** Piece 1 (P1-7): when a delivery window exists, the start
     * departure that delivers exactly at its close; null otherwise
     * or when no start was given. */
    leaveStartByAt: string | null;
  };
  plan: {
    arrivalAt: string | null;
    totalElapsedMinutes: number;
    breaks: PlannedBreak[];
    rests: (PlannedRest & { point: LatLng | null })[];
    /** Piece 1 (P1-9): the requested workout's outcome; null only
     * when no workout was requested. */
    workout: WorkoutOutcome | null;
  } | null;
  /** Piece 1 (P1-7): the deadhead leg to the pickup; null when the
   * request carried no start. Timings come from the lib's preLeg
   * simulation - never re-derived here. */
  deadhead: {
    startLabel: string;
    startPoint: LatLng;
    distanceMiles: number;
    providerDurationMinutes: number;
    provider: string;
    truckLegal: boolean;
    geometry: LatLng[];
    leaveByAt: string;
    pickupArrivalAt: string;
    waitMinutesAtPickup: number;
    /** Drive Mode D1: turn prompts for the deadhead leg, when the provider returned them. */
    maneuvers?: RouteManeuver[];
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
