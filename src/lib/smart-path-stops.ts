// Smart Path v1 (docs/design/driver-mvp.md §8.3): fuel and food stop
// math. Pure functions over candidates the service layer assembled -
// no network here. The rule the owner set: fuel is ranked on
// EFFECTIVE cost (what the stop really costs, detour and clock
// included), never sticker price alone; food is planned around what
// the truck can actually cook/store and is suppressed entirely
// inside his 8pm-8am fast.

import type { TruckAppliance } from "@/types/entities";
import { formatMinutes, isInFastWindow, type LatLng } from "./smart-path";

// ----------------------------------------------------------------------- fuel

export interface FuelCandidate extends LatLng {
  id: string;
  name: string;
  /** Cents per gallon; null when the source has no price (OSM rarely does). */
  pricePerGallonCents: number | null;
  source: "history" | "map";
  /** Round-trip miles off the route to reach this stop and come back. */
  detourMiles: number;
}

export interface FuelAssumptions {
  gallonsToBuy: number;
  avgMpg: number;
  /** What an hour of his clock is priced at, for detour/idle time. Named, not buried (design §8.3). */
  valueOfTimeCentsPerHour: number;
  avgDetourSpeedMph: number;
  /** Minutes a fuel stop itself takes (fueling + in/out), priced as idle time. */
  stopMinutes: number;
}

export const DEFAULT_FUEL_ASSUMPTIONS: Omit<FuelAssumptions, "gallonsToBuy" | "avgMpg"> = {
  valueOfTimeCentsPerHour: 2500, // $25/h
  avgDetourSpeedMph: 35,
  stopMinutes: 12,
};

export interface RankedFuelCandidate extends FuelCandidate {
  pumpCostCents: number | null;
  /** Fuel + time burned on the detour and the stop itself. */
  detourCostCents: number;
  /** pump + detour; null when the price is unknown. */
  effectiveCostCents: number | null;
  /** Effective cost vs buying the same gallons at the baseline price on-route. */
  savingsVsBaselineCents: number | null;
}

export function rankFuelCandidates(
  candidates: FuelCandidate[],
  assumptions: FuelAssumptions,
  baselinePriceCents: number | null,
): RankedFuelCandidate[] {
  const ranked = candidates.map((candidate) => {
    const detourPrice = candidate.pricePerGallonCents ?? baselinePriceCents;
    const detourFuelCents =
      detourPrice !== null ? (candidate.detourMiles / assumptions.avgMpg) * detourPrice : 0;
    const detourTimeCents =
      (candidate.detourMiles / assumptions.avgDetourSpeedMph) *
      assumptions.valueOfTimeCentsPerHour;
    const stopCostCents = (assumptions.stopMinutes / 60) * assumptions.valueOfTimeCentsPerHour;
    const detourCostCents = Math.round(detourFuelCents + detourTimeCents + stopCostCents);

    const pumpCostCents =
      candidate.pricePerGallonCents !== null
        ? Math.round(candidate.pricePerGallonCents * assumptions.gallonsToBuy)
        : null;
    const effectiveCostCents =
      pumpCostCents !== null ? pumpCostCents + detourCostCents : null;
    const savingsVsBaselineCents =
      effectiveCostCents !== null && baselinePriceCents !== null
        ? Math.round(baselinePriceCents * assumptions.gallonsToBuy - effectiveCostCents)
        : null;

    return { ...candidate, pumpCostCents, detourCostCents, effectiveCostCents, savingsVsBaselineCents };
  });

  // Priced candidates first, cheapest effective cost first; unpriced
  // after, shortest detour first. An unknown price never outranks a
  // known one - that would be a guess dressed as a ranking.
  return ranked.sort((a, b) => {
    if (a.effectiveCostCents !== null && b.effectiveCostCents !== null) {
      return a.effectiveCostCents - b.effectiveCostCents;
    }
    if (a.effectiveCostCents !== null) return -1;
    if (b.effectiveCostCents !== null) return 1;
    return a.detourMiles - b.detourMiles;
  });
}

// ----------------------------------------------------------------------- food

export type FoodMode = "grocery" | "fast_food";

export interface FoodCandidate extends LatLng {
  id: string;
  name: string;
  kind: "grocery" | "fast_food";
  detourMiles: number;
  /** When the plan says he'd reach this stop. */
  arrivalAt: string;
}

export type GroceryPlanKind = "full_cook" | "cold" | "not_workable";

export interface GroceryPlan {
  kind: GroceryPlanKind;
  viable: boolean;
  lines: string[];
}

const COOKING_APPLIANCES: TruckAppliance[] = ["microwave", "air_fryer", "hot_plate"];
const STORAGE_APPLIANCES: TruckAppliance[] = ["fridge", "cooler"];

/**
 * What a grocery stop can actually become, given what's in the cab.
 * This is the filter no generic maps app can run (vision doc §9e):
 * groceries are only a plan if the truck can store and/or cook them.
 */
export function groceryPlanForAppliances(appliances: TruckAppliance[]): GroceryPlan {
  const hasCooking = COOKING_APPLIANCES.some((a) => appliances.includes(a));
  const hasStorage = STORAGE_APPLIANCES.some((a) => appliances.includes(a));

  if (hasCooking && hasStorage) {
    return {
      kind: "full_cook",
      viable: true,
      lines: [
        "Your truck can store and cook - a grocery stop is a full meal plan: buy real food, cook in the cab, eat inside your window.",
      ],
    };
  }
  if (hasStorage) {
    return {
      kind: "cold",
      viable: true,
      lines: [
        "You have cold storage but nothing to cook with - a grocery stop is a cold plan: sandwiches, salads, fruit, things that eat well uncooked. Add a cooking appliance and this becomes the full plan.",
      ],
    };
  }
  if (hasCooking) {
    return {
      kind: "cold",
      viable: true,
      lines: [
        "You can cook but have no cold storage - a grocery stop works only for food you'll cook and eat the same stop. Shelf-stable and same-day items only.",
      ],
    };
  }
  return {
    kind: "not_workable",
    viable: false,
    lines: [
      "Nothing in this truck stores or cooks food (per its appliance inventory), so a grocery stop can't become meals - grocery mode is off for this truck until the cab has at least a cooler or a cooking appliance. Fast-food mode still works.",
    ],
  };
}

export interface FoodPlan {
  mode: FoodMode;
  groceryPlan: GroceryPlan | null;
  stops: FoodCandidate[];
  /** Candidate names suppressed because they'd fall inside the 8pm-8am fast. */
  suppressedByFast: string[];
  lines: string[];
}

export function planFoodStops(
  candidates: FoodCandidate[],
  mode: FoodMode,
  appliances: TruckAppliance[],
): FoodPlan {
  const lines: string[] = [];
  const groceryPlan = mode === "grocery" ? groceryPlanForAppliances(appliances) : null;
  if (groceryPlan) lines.push(...groceryPlan.lines);

  const ofKind = candidates.filter((c) => c.kind === (mode === "grocery" ? "grocery" : "fast_food"));
  const suppressedByFast: string[] = [];
  const inWindow: FoodCandidate[] = [];
  for (const candidate of ofKind) {
    if (isInFastWindow(new Date(candidate.arrivalAt))) {
      suppressedByFast.push(candidate.name);
    } else {
      inWindow.push(candidate);
    }
  }
  if (suppressedByFast.length > 0) {
    lines.push(
      `Food stops near ${suppressedByFast.join(", ")} fall inside your 8pm-8am fast, so they're not suggested - food planning stays outside the fast.`,
    );
  }

  if (groceryPlan && !groceryPlan.viable) {
    return { mode, groceryPlan, stops: [], suppressedByFast, lines };
  }

  const stops = [...inWindow].sort((a, b) => a.detourMiles - b.detourMiles).slice(0, 5);
  if (stops.length === 0 && suppressedByFast.length === 0) {
    lines.push(
      mode === "grocery"
        ? "No grocery stores found near this route in the map data."
        : "No fast-food places found near this route in the map data.",
    );
  }
  return { mode, groceryPlan, stops, suppressedByFast, lines };
}

/** Small shared formatter for stop lists in the UI. */
export function describeDetour(detourMiles: number): string {
  if (detourMiles < 0.1) return "right on the route";
  return `${detourMiles.toFixed(1)} mi off the route (about ${formatMinutes((detourMiles / 35) * 60)} of driving)`;
}
