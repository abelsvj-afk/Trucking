import { describe, expect, it } from "vitest";
import { getRegionalDiesel, regionalDieselFromPoint } from "@/services/smart-path/regional-fuel";

const NOW = new Date("2026-11-05T15:00:00Z");

describe("regionalDieselFromPoint", () => {
  it("labels the region's average and never calls it a station price", () => {
    const r = regionalDieselFromPoint("R30", "Gulf Coast", { period: "2026-11-02", pricePerGallon: 3.789, units: "$/GAL" }, NOW)!;
    expect(r.cents).toBe(379);
    expect(r.label).toBe("EIA Gulf Coast weekly average, week of Nov 2 - not this station's price");
    expect(r.freshness).toBe("fresh");
  });
  it("marks aging at 8 days and stale at 10", () => {
    expect(regionalDieselFromPoint("R10", "East Coast", { period: "2026-10-28", pricePerGallon: 4, units: "" }, NOW)!.freshness).toBe("aging");
    expect(regionalDieselFromPoint("R10", "East Coast", { period: "2026-10-25", pricePerGallon: 4, units: "" }, NOW)!.freshness).toBe("stale");
  });
  it("rejects bad figures and dates", () => {
    expect(regionalDieselFromPoint("R10", "x", { period: "2026-11-02", pricePerGallon: 0, units: "" }, NOW)).toBeNull();
    expect(regionalDieselFromPoint("R10", "x", { period: "nope", pricePerGallon: 4, units: "" }, NOW)).toBeNull();
    expect(regionalDieselFromPoint("R10", "x", undefined, NOW)).toBeNull();
  });
});

describe("getRegionalDiesel", () => {
  it("is null (never throws) when EIA fails", async () => {
    expect(await getRegionalDiesel("R20", "Midwest", async () => { throw new Error("EIA down"); }, NOW)).toBeNull();
  });
  it("passes the PADD code as the EIA facet", async () => {
    let seen = "";
    await getRegionalDiesel("R40", "Rocky Mountain", async (_n, area) => { seen = area; return [{ period: "2026-11-02", pricePerGallon: 3.5, units: "" }]; }, NOW);
    expect(seen).toBe("R40");
  });
});
