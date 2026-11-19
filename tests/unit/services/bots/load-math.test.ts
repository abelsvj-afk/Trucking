// Dispatch Scout profit math: exact cents on the happy path, and
// honest nulls (never guesses) when a load cannot be priced.
import { describe, expect, it } from "vitest";
import type { BoardLoad } from "@/services/bots/boards";
import { exitWarning, meetsFloor, priceLoad, rankLoads, type PricedLoad } from "@/services/bots/load-math";

function makeLoad(overrides: Partial<BoardLoad> = {}): BoardLoad {
  return {
    boardSlug: "trulos",
    externalRef: "test-1",
    origin: "Atlanta, GA",
    destination: "Charlotte, NC",
    pickupDate: "2026-11-20",
    equipment: "Dry Van",
    rateCents: 185000,
    rateCentsPerLoadedMile: null,
    weightLbs: 30000,
    loadedMiles: 500,
    deadheadMiles: 100,
    brokerName: "Test Broker",
    brokerCreditScore: 90,
    brokerDaysToPay: 21,
    contactRef: null,
    rawNote: null,
    ...overrides,
  };
}

const PRICING = { costPerMileCents: 120, dieselCentsPerGallon: 600, mpg: 7 };

describe("priceLoad", () => {
  it("prices the happy path to exact cents", () => {
    const { priced, reason } = priceLoad({ load: makeLoad(), ...PRICING });
    expect(reason).toBeNull();
    expect(priced).not.toBeNull();
    if (priced === null) return;
    expect(priced.payCents).toBe(185000);
    expect(priced.loadedMiles).toBe(500);
    expect(priced.deadheadMiles).toBe(100);
    expect(priced.totalMiles).toBe(600);
    expect(priced.perLoadedMileCents).toBe(370);
    expect(priced.perAllMilesCents).toBe(308.33);
    expect(priced.fuelCents).toBe(51429);
    expect(priced.profitCents).toBe(61571);
    expect(priced.profitPerAllMileCents).toBe(102.62);
    expect(priced.tripDays).toBe(1);
    expect(priced.profitPerDayCents).toBe(61571);
  });

  it("derives pay from the per-mile rate when no flat rate is given", () => {
    const { priced } = priceLoad({
      load: makeLoad({ rateCents: null, rateCentsPerLoadedMile: 370 }),
      ...PRICING,
    });
    expect(priced?.payCents).toBe(185000);
    expect(priced?.perLoadedMileCents).toBe(370);
  });

  it("counts trip days from pickup to delivery, minimum 1", () => {
    const { priced } = priceLoad({
      load: makeLoad({ pickupDate: "2026-11-20" }),
      deliveryDate: "2026-11-22",
      ...PRICING,
    });
    expect(priced?.tripDays).toBe(2);
    expect(priced?.profitPerDayCents).toBe(30786);
  });

  it("returns null with a reason when no rate is quoted", () => {
    const { priced, reason } = priceLoad({
      load: makeLoad({ rateCents: null, rateCentsPerLoadedMile: null }),
      ...PRICING,
    });
    expect(priced).toBeNull();
    expect(reason).toMatch(/no pay/i);
  });

  it("returns null with a reason when miles are missing", () => {
    const { priced, reason } = priceLoad({ load: makeLoad({ loadedMiles: null }), ...PRICING });
    expect(priced).toBeNull();
    expect(reason).toMatch(/loaded miles/i);
  });

  it("returns null with a reason when deadhead is zero or missing", () => {
    const zero = priceLoad({ load: makeLoad({ deadheadMiles: 0 }), ...PRICING });
    expect(zero.priced).toBeNull();
    expect(zero.reason).toMatch(/deadhead/i);
    const missing = priceLoad({ load: makeLoad({ deadheadMiles: null }), ...PRICING });
    expect(missing.priced).toBeNull();
    expect(missing.reason).toMatch(/deadhead/i);
  });

  it("returns null with a reason when mpg is zero", () => {
    const { priced, reason } = priceLoad({ load: makeLoad(), ...PRICING, mpg: 0 });
    expect(priced).toBeNull();
    expect(reason).toMatch(/miles per gallon/i);
  });

  it("returns null with a reason when cost per mile is zero", () => {
    const { priced, reason } = priceLoad({ load: makeLoad(), ...PRICING, costPerMileCents: 0 });
    expect(priced).toBeNull();
    expect(reason).toMatch(/cost per mile/i);
  });
});

describe("meetsFloor", () => {
  it("passes when profit per all mile equals the floor", () => {
    const { priced } = priceLoad({ load: makeLoad(), ...PRICING });
    if (priced === null) throw new Error("happy-path load should price");
    expect(meetsFloor(priced, 102.62)).toBe(true);
    expect(meetsFloor(priced, 102.63)).toBe(false);
  });
});

describe("rankLoads", () => {
  function pricedFor(rateCents: number): PricedLoad {
    const { priced } = priceLoad({ load: makeLoad({ rateCents }), ...PRICING });
    if (priced === null) throw new Error("load should price");
    return priced;
  }

  it("orders by profit per all mile, then profit per day, then pay", () => {
    const low = pricedFor(150000);
    const mid = pricedFor(185000);
    const high = pricedFor(220000);
    expect(rankLoads([low, high, mid]).map((entry) => entry.payCents)).toEqual([220000, 185000, 150000]);
  });

  it("does not mutate the input array", () => {
    const loads = [pricedFor(150000), pricedFor(220000)];
    const ranked = rankLoads(loads);
    expect(loads.map((entry) => entry.payCents)).toEqual([150000, 220000]);
    expect(ranked.map((entry) => entry.payCents)).toEqual([220000, 150000]);
  });
});

describe("exitWarning", () => {
  function pricedFor(destination: string): PricedLoad {
    const { priced } = priceLoad({ load: makeLoad({ destination }), ...PRICING });
    if (priced === null) throw new Error("load should price");
    return priced;
  }

  it("warns for a Florida delivery", () => {
    expect(exitWarning(pricedFor("Miami, FL"))).toMatch(/Florida delivery with no exit load priced/);
    expect(exitWarning(pricedFor("Orlando FL"))).toMatch(/Florida delivery/);
    expect(exitWarning(pricedFor("Tampa, fl"))).toMatch(/Florida delivery/);
  });

  it("stays silent for any other destination", () => {
    expect(exitWarning(pricedFor("Atlanta, GA"))).toBeNull();
    expect(exitWarning(pricedFor("Charlotte, NC"))).toBeNull();
    expect(exitWarning(pricedFor("Dallas, TX"))).toBeNull();
  });
});
