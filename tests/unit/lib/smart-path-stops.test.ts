// Smart Path v1 (docs/design/driver-mvp.md §8.3). The two rankings
// the owner specified in his own words: fuel by EFFECTIVE cost (a
// cheap pump price 60 miles off-route is not cheap), and food by
// what the truck can actually do with groceries - plus the standing
// rule that food is never suggested inside his 8pm-8am fast.

import { describe, expect, it } from "vitest";
import {
  groceryPlanForAppliances,
  planFoodStops,
  rankFuelCandidates,
  type FoodCandidate,
  type FuelAssumptions,
  type FuelCandidate,
} from "@/lib/smart-path-stops";
import { formatFuelPriceLine } from "@/lib/smart-path-stops";

const ASSUMPTIONS: FuelAssumptions = {
  gallonsToBuy: 100,
  avgMpg: 6.5,
  valueOfTimeCentsPerHour: 2500,
  avgDetourSpeedMph: 35,
  stopMinutes: 12,
};

function fuel(overrides: Partial<FuelCandidate>): FuelCandidate {
  return {
    id: "x",
    name: "Stop",
    lat: 30,
    lng: -82,
    pricePerGallonCents: 400,
    source: "history",
    detourMiles: 0,
    ...overrides,
  };
}

describe("rankFuelCandidates - effective cost, not sticker price", () => {
  it("a pricey station on the route beats a cheap one 60 miles off it", () => {
    const cheapFar = fuel({ id: "cheap-far", name: "Cheap Far", pricePerGallonCents: 350, detourMiles: 60 });
    const priceyNear = fuel({ id: "pricey-near", name: "Pricey Near", pricePerGallonCents: 420, detourMiles: 1 });
    const ranked = rankFuelCandidates([cheapFar, priceyNear], ASSUMPTIONS, 460);
    expect(ranked[0]?.id).toBe("pricey-near");
    // Pricey Near: pump 42000 + detour fuel ~65 + detour time ~71 + stop 500.
    expect(ranked[0]?.effectiveCostCents).toBe(42636);
    // Cheap Far: pump 35000 + detour fuel ~3231 + detour time ~4286 + stop 500 (rounded once).
    expect(ranked[1]?.effectiveCostCents).toBe(43016);
    expect(ranked[0]?.savingsVsBaselineCents).toBe(46000 - 42636);
  });

  it("an unknown price never outranks a known one, however short its detour", () => {
    const unknown = fuel({ id: "unknown", name: "Map Station", pricePerGallonCents: null, source: "map", detourMiles: 0 });
    const known = fuel({ id: "known", name: "Known", pricePerGallonCents: 500, detourMiles: 10 });
    const ranked = rankFuelCandidates([unknown, known], ASSUMPTIONS, null);
    expect(ranked[0]?.id).toBe("known");
    expect(ranked[1]?.effectiveCostCents).toBeNull();
    expect(ranked[1]?.pumpCostCents).toBeNull();
  });

  it("detour cost is charged even when the pump price ties", () => {
    const onRoute = fuel({ id: "on", detourMiles: 0 });
    const offRoute = fuel({ id: "off", detourMiles: 20 });
    const ranked = rankFuelCandidates([offRoute, onRoute], ASSUMPTIONS, null);
    expect(ranked[0]?.id).toBe("on");
    expect(ranked[0]?.detourCostCents).toBe(500); // just the stop itself
    expect(ranked[1]?.detourCostCents).toBeGreaterThan(2000);
  });
});

describe("groceryPlanForAppliances - the truck decides what groceries mean", () => {
  it("fridge + microwave is the full cook plan", () => {
    const plan = groceryPlanForAppliances(["fridge", "microwave", "inverter"]);
    expect(plan.kind).toBe("full_cook");
    expect(plan.viable).toBe(true);
  });

  it("cooler only is a cold plan, and says what would upgrade it", () => {
    const plan = groceryPlanForAppliances(["cooler"]);
    expect(plan.kind).toBe("cold");
    expect(plan.viable).toBe(true);
    expect(plan.lines[0]).toContain("nothing to cook with");
  });

  it("cooking with no storage is same-day only", () => {
    const plan = groceryPlanForAppliances(["hot_plate"]);
    expect(plan.kind).toBe("cold");
    expect(plan.viable).toBe(true);
    expect(plan.lines[0]).toContain("no cold storage");
  });

  it("no appliances (or an explicit 'none') makes grocery mode not workable", () => {
    for (const appliances of [[], ["none"]] as const) {
      const plan = groceryPlanForAppliances([...appliances]);
      expect(plan.kind).toBe("not_workable");
      expect(plan.viable).toBe(false);
    }
  });

  it("a coffee maker alone is not a cooking appliance", () => {
    expect(groceryPlanForAppliances(["coffee_maker"]).viable).toBe(false);
  });
});

function food(overrides: Partial<FoodCandidate>): FoodCandidate {
  return {
    id: "f",
    name: "Place",
    kind: "grocery",
    lat: 30,
    lng: -82,
    detourMiles: 1,
    arrivalAt: "2026-11-02T17:00:00Z", // noon EST - inside the eating window
    ...overrides,
  };
}

describe("planFoodStops", () => {
  it("grocery mode with no working cab setup returns no stops and says why", () => {
    const plan = planFoodStops([food({})], "grocery", ["none"]);
    expect(plan.stops).toEqual([]);
    expect(plan.groceryPlan?.viable).toBe(false);
    expect(plan.lines.some((line) => line.includes("grocery mode is off"))).toBe(true);
  });

  it("grocery stops are ranked by detour when the cab can cook", () => {
    const plan = planFoodStops(
      [food({ id: "far", name: "Far Mart", detourMiles: 8 }), food({ id: "near", name: "Near Mart", detourMiles: 1 })],
      "grocery",
      ["fridge", "air_fryer"],
    );
    expect(plan.stops.map((s) => s.id)).toEqual(["near", "far"]);
  });

  it("suppresses any stop that would be reached inside the 8pm-8am fast", () => {
    const plan = planFoodStops(
      [
        food({ id: "night", name: "Night Burger", kind: "fast_food", arrivalAt: "2026-11-02T02:30:00Z" }), // 9:30 PM EST
        food({ id: "lunch", name: "Lunch Burger", kind: "fast_food", arrivalAt: "2026-11-02T17:00:00Z" }), // noon EST
        food({ id: "dawn", name: "Dawn Burger", kind: "fast_food", arrivalAt: "2026-11-02T12:30:00Z" }), // 7:30 AM EST
      ],
      "fast_food",
      [],
    );
    expect(plan.stops.map((s) => s.id)).toEqual(["lunch"]);
    expect(plan.suppressedByFast).toEqual(expect.arrayContaining(["Night Burger", "Dawn Burger"]));
    expect(plan.lines.some((line) => line.includes("8pm-8am fast"))).toBe(true);
  });

  it("mode filters the kind: grocery mode never returns fast food", () => {
    const plan = planFoodStops(
      [food({ id: "ff", kind: "fast_food" }), food({ id: "g", kind: "grocery" })],
      "grocery",
      ["fridge", "microwave"],
    );
    expect(plan.stops.map((s) => s.id)).toEqual(["g"]);
  });
});

// ---------------------------------------------------------------------
// Piece 1 additions (P1-6): the EIA estimate tier. The trust order is
// logged > estimate > unknown, and an estimate never claims savings.
// ---------------------------------------------------------------------

describe("rankFuelCandidates - estimate tier (P1-6)", () => {
  it("(a) an estimate-only candidate ranks by its estimate-based effective cost; (b) savings stay null for it and real for a logged price", () => {
    const estimateOnly = fuel({
      id: "est",
      name: "Map Stop",
      pricePerGallonCents: null,
      estimatedPricePerGallonCents: 350,
      estimateLabel: "EIA U.S. average, week of Oct 26",
      source: "map",
      detourMiles: 0,
    });
    const logged = fuel({ id: "logged", pricePerGallonCents: 400, detourMiles: 0 });
    const ranked = rankFuelCandidates([logged, estimateOnly], ASSUMPTIONS, 460);
    expect(ranked[0]?.id).toBe("est");
    // Estimate competes on cost: 350 * 100 gal + 500 stop cost.
    expect(ranked[0]?.effectiveCostCents).toBe(35500);
    expect(ranked[0]?.usedEstimate).toBe(true);
    // Pump cost stays real-only - the estimate never poses as a pump price.
    expect(ranked[0]?.pumpCostCents).toBeNull();
    expect(ranked[0]?.savingsVsBaselineCents).toBeNull();
    expect(ranked[1]?.id).toBe("logged");
    expect(ranked[1]?.effectiveCostCents).toBe(40500);
    expect(ranked[1]?.savingsVsBaselineCents).toBe(46000 - 40500);
    expect(ranked[1]?.usedEstimate).toBe(false);
  });

  it("(c) a real price present means the estimate is ignored entirely", () => {
    const both = fuel({
      id: "both",
      pricePerGallonCents: 400,
      estimatedPricePerGallonCents: 300,
      estimateLabel: "EIA U.S. average, week of Oct 26",
      detourMiles: 0,
    });
    const ranked = rankFuelCandidates([both], ASSUMPTIONS, 460);
    expect(ranked[0]?.usedEstimate).toBe(false);
    expect(ranked[0]?.effectiveCostCents).toBe(40500);
    expect(ranked[0]?.pumpCostCents).toBe(40000);
  });

  it("detour fuel for an estimate candidate is priced at the estimate, not the baseline", () => {
    const est = fuel({
      id: "est-detour",
      pricePerGallonCents: null,
      estimatedPricePerGallonCents: 350,
      estimateLabel: "EIA U.S. average, week of Oct 26",
      source: "map",
      detourMiles: 10,
    });
    const ranked = rankFuelCandidates([est], ASSUMPTIONS, 460);
    // (10 / 6.5) * 350 fuel + (10 / 35) * 2500 time + 500 stop, rounded once.
    expect(ranked[0]?.detourCostCents).toBe(1753);
  });

  it("no estimate anywhere reproduces the old ranking exactly (unknown stays last, unpriced)", () => {
    const unknown = fuel({ id: "unknown", pricePerGallonCents: null, source: "map", detourMiles: 0 });
    const ranked = rankFuelCandidates([unknown], ASSUMPTIONS, 460);
    expect(ranked[0]?.usedEstimate).toBe(false);
    expect(ranked[0]?.effectiveCostCents).toBeNull();
  });
});

describe("formatFuelPriceLine (P1-6)", () => {
  it("real price: from your fuel log", () => {
    const ranked = rankFuelCandidates([fuel({ pricePerGallonCents: 379 })], ASSUMPTIONS, null);
    expect(formatFuelPriceLine(ranked[0]!)).toBe("$3.79/gal (from your fuel log)");
  });

  it("estimate: ≈ and the estimate label", () => {
    const ranked = rankFuelCandidates(
      [
        fuel({
          pricePerGallonCents: null,
          estimatedPricePerGallonCents: 392,
          estimateLabel: "EIA U.S. average, week of Oct 26",
          source: "map",
        }),
      ],
      ASSUMPTIONS,
      null,
    );
    expect(formatFuelPriceLine(ranked[0]!)).toBe(
      "≈$3.92/gal (est. — EIA U.S. average, week of Oct 26)",
    );
  });

  it("neither: price unknown", () => {
    const ranked = rankFuelCandidates(
      [fuel({ pricePerGallonCents: null, source: "map" })],
      ASSUMPTIONS,
      null,
    );
    expect(formatFuelPriceLine(ranked[0]!)).toBe("price unknown");
  });
});
