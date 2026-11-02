// Smart Path Piece 1 (P1-6): the EIA diesel estimate seam.
// - $/gal from the snapshot becomes rounded cents, always labeled
//   as the EIA U.S. average for that week - never a station price.
// - Any failure (missing key, upstream throw, bad shape) is null.
//   The estimate must never throw into a route check.

import { describe, expect, it, vi } from "vitest";
import type { FuelMarketSnapshot } from "@/services/integrations/eia";
import {
  dieselEstimateFromSnapshot,
  getDieselPriceEstimate,
} from "@/services/smart-path/fuel-price-estimate";

const SNAPSHOT: FuelMarketSnapshot = {
  label: "U.S. average diesel retail price",
  period: "2026-10-26",
  pricePerGallon: 3.924,
  units: "$/gal",
};

describe("dieselEstimateFromSnapshot", () => {
  it("converts $3.924/gal to 392 cents with the EIA week label", () => {
    const estimate = dieselEstimateFromSnapshot(SNAPSHOT);
    expect(estimate).not.toBeNull();
    expect(estimate!.cents).toBe(392);
    expect(estimate!.label).toBe("EIA U.S. average, week of Oct 26");
    expect(estimate!.label).toContain("Oct 26");
  });

  it("falls back to the raw period text when it is not a parseable date", () => {
    const estimate = dieselEstimateFromSnapshot({ ...SNAPSHOT, period: "last week" });
    expect(estimate!.label).toBe("EIA U.S. average, week of last week");
  });

  it("returns null when there is no usable price", () => {
    expect(dieselEstimateFromSnapshot(null)).toBeNull();
    expect(dieselEstimateFromSnapshot(undefined)).toBeNull();
    expect(
      dieselEstimateFromSnapshot({ ...SNAPSHOT, pricePerGallon: Number.NaN }),
    ).toBeNull();
    expect(dieselEstimateFromSnapshot({ ...SNAPSHOT, pricePerGallon: 0 })).toBeNull();
  });
});

describe("getDieselPriceEstimate", () => {
  it("returns the estimate from the injected fetcher", async () => {
    const fetcher = vi.fn(async () => SNAPSHOT);
    await expect(getDieselPriceEstimate(fetcher)).resolves.toEqual({
      cents: 392,
      label: "EIA U.S. average, week of Oct 26",
    });
  });

  it("memoizes per fetcher - a second call does not refetch", async () => {
    const fetcher = vi.fn(async () => SNAPSHOT);
    await getDieselPriceEstimate(fetcher);
    await getDieselPriceEstimate(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns null (never throws) when the fetcher throws", async () => {
    const fetcher = vi.fn(async (): Promise<FuelMarketSnapshot> => {
      throw new Error("EIA_API_KEY is not configured.");
    });
    await expect(getDieselPriceEstimate(fetcher)).resolves.toBeNull();
  });

  it("returns null when the fetcher hands back a bad shape", async () => {
    const fetcher = vi.fn(
      async () => ({ period: "2026-10-26" }) as unknown as FuelMarketSnapshot,
    );
    await expect(getDieselPriceEstimate(fetcher)).resolves.toBeNull();
  });
});
