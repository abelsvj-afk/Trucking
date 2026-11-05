import { describe, expect, it } from "vitest";
import { suggestLoadsForFuel } from "@/lib/fuel-load-suggestion";

const load = (o: Record<string, unknown>) => ({ id: "l1", truck_id: "t1", pickup_date: "2026-11-01", delivery_date: "2026-11-03", status: "completed", ...o }) as never;

describe("suggestLoadsForFuel (D.5.3: suggests, never assigns)", () => {
  it("offers a load on the same truck whose dates cover the purchase", () => {
    expect(suggestLoadsForFuel([load({})], "t1", "2026-11-02T15:00:00Z")).toEqual(["l1"]);
  });
  it("offers nothing for another truck, outside the dates, or a cancelled load", () => {
    expect(suggestLoadsForFuel([load({ truck_id: "t2" })], "t1", "2026-11-02T15:00:00Z")).toEqual([]);
    expect(suggestLoadsForFuel([load({})], "t1", "2026-11-09T15:00:00Z")).toEqual([]);
    expect(suggestLoadsForFuel([load({ status: "cancelled" })], "t1", "2026-11-02T15:00:00Z")).toEqual([]);
  });
  it("offers nothing with no truck or date chosen", () => {
    expect(suggestLoadsForFuel([load({})], "", "2026-11-02")).toEqual([]);
  });
});
