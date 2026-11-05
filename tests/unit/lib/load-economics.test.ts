import { describe, expect, it } from "vitest";
import { computeLoadEconomics } from "@/lib/load-economics";

const delivered = { rate_cents: 200000, status: "completed", delivery_date: "2026-10-30" };

describe("computeLoadEconomics (D.5)", () => {
  it("margin = rate - assigned expenses - assigned fuel, each traceable", () => {
    const e = computeLoadEconomics(delivered, [10000, 5000], [40000]);
    expect(e.directExpensesCents).toBe(15000);
    expect(e.directFuelCents).toBe(40000);
    expect(e.contributionMarginCents).toBe(145000);
    expect(e.provisional).toBe(false);
    expect(e.excluded).toContain("fuel not assigned to a load");
  });
  it("a load with no assigned fuel carries the may-read-high caveat", () => {
    expect(computeLoadEconomics(delivered, [], []).caveat).toContain("may read higher");
  });
  it("a non-delivered load is provisional", () => {
    expect(computeLoadEconomics({ ...delivered, status: "confirmed" }, [], [1]).provisional).toBe(true);
    expect(computeLoadEconomics({ ...delivered, delivery_date: null }, [], [1]).provisional).toBe(true);
  });
  it("no rate means no margin, said plainly", () => {
    const e = computeLoadEconomics({ ...delivered, rate_cents: null }, [100], [100]);
    expect(e.contributionMarginCents).toBeNull();
    expect(e.caveat).toContain("no rate");
  });
  it("the margin can be negative and is never clamped", () => {
    expect(computeLoadEconomics(delivered, [], [300000]).contributionMarginCents).toBe(-100000);
  });
});
