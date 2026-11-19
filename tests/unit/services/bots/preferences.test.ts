// Dispatch Scout preference learning: thin data suggests nothing,
// enough booked history suggests a floor from the lowest booked
// $ per ALL mile — and learning never applies anything by itself.
import { describe, expect, it } from "vitest";
import { learnPreferences, type LedgerRowLike } from "@/services/bots/preferences";

function makeRow(overrides: Partial<LedgerRowLike> = {}): LedgerRowLike {
  return {
    load_ref: "test-1",
    broker_name: "Test Broker",
    origin: "Atlanta, GA",
    destination: "Charlotte, NC",
    rate_cents_per_loaded_mile: 300,
    loaded_miles: 500,
    deadhead_miles: 100,
    pay_cents: 150000,
    fuel_cents: 50000,
    outcome: "booked",
    notes: null,
    ...overrides,
  };
}

describe("learnPreferences", () => {
  it("returns empty learning with no floor suggestion on no rows", () => {
    const learned = learnPreferences([]);
    expect(learned.bookedCount).toBe(0);
    expect(learned.skippedCount).toBe(0);
    expect(learned.hasEnoughData).toBe(false);
    expect(learned.minBookedPerAllMileCents).toBeNull();
    expect(learned.preferredLanes).toEqual([]);
    expect(learned.commonSkipReasons).toEqual([]);
    expect(learned.suggestedFloorCents).toBeNull();
  });

  it("suggests the lowest booked $ per all mile once 3 loads are booked", () => {
    const learned = learnPreferences([
      // $150,000 / 600 total mi = $2.50 per all mile.
      makeRow({ load_ref: "a", pay_cents: 150000 }),
      // $180,000 / 600 = $3.00 per all mile.
      makeRow({ load_ref: "b", pay_cents: 180000 }),
      // $165,000 / 600 = $2.75 per all mile.
      makeRow({ load_ref: "c", pay_cents: 165000 }),
    ]);
    expect(learned.bookedCount).toBe(3);
    expect(learned.hasEnoughData).toBe(true);
    expect(learned.minBookedPerAllMileCents).toBe(250);
    expect(learned.suggestedFloorCents).toBe(250);
  });

  it("suggests no floor below 3 booked loads, even when a minimum exists", () => {
    const learned = learnPreferences([
      makeRow({ load_ref: "a", pay_cents: 150000 }),
      makeRow({ load_ref: "b", pay_cents: 180000 }),
    ]);
    expect(learned.hasEnoughData).toBe(false);
    expect(learned.minBookedPerAllMileCents).toBe(250);
    expect(learned.suggestedFloorCents).toBeNull();
  });

  it("leaves booked rows without pay or miles out of the floor math", () => {
    const learned = learnPreferences([
      makeRow({ load_ref: "a", pay_cents: 150000 }),
      makeRow({ load_ref: "b", pay_cents: null }),
      makeRow({ load_ref: "c", pay_cents: 180000, loaded_miles: null }),
      makeRow({ load_ref: "d", pay_cents: 165000 }),
    ]);
    expect(learned.bookedCount).toBe(4);
    expect(learned.hasEnoughData).toBe(true);
    expect(learned.minBookedPerAllMileCents).toBe(250);
    expect(learned.suggestedFloorCents).toBe(250);
  });

  it("counts preferred lanes among booked loads, most-booked first", () => {
    const learned = learnPreferences([
      makeRow({ load_ref: "a", origin: "Atlanta, GA", destination: "Charlotte, NC" }),
      makeRow({ load_ref: "b", origin: "Atlanta, GA", destination: "Charlotte, NC" }),
      makeRow({ load_ref: "c", origin: "Dallas, TX", destination: "Houston, TX" }),
      makeRow({ load_ref: "d", origin: "Atlanta, GA", destination: "Charlotte, NC", outcome: "skipped" }),
    ]);
    expect(learned.preferredLanes).toEqual([
      { origin: "Atlanta, GA", destination: "Charlotte, NC", bookedCount: 2 },
      { origin: "Dallas, TX", destination: "Houston, TX", bookedCount: 1 },
    ]);
  });

  it("tallies common skip reasons from notes, phrase before the separator", () => {
    const learned = learnPreferences([
      makeRow({ load_ref: "a", outcome: "skipped", notes: "Below floor — $2.10 per all mile vs floor $2.50" }),
      makeRow({ load_ref: "b", outcome: "skipped", notes: "Below floor — $1.90 per all mile vs floor $2.50" }),
      makeRow({ load_ref: "c", outcome: "skipped", notes: "Too far deadhead" }),
      makeRow({ load_ref: "d", outcome: "skipped", notes: null }),
      makeRow({ load_ref: "e", outcome: "booked", notes: "Below floor — should not count" }),
    ]);
    expect(learned.skippedCount).toBe(4);
    expect(learned.commonSkipReasons).toEqual([
      { reason: "Below floor", count: 2 },
      { reason: "Too far deadhead", count: 1 },
    ]);
  });
});
