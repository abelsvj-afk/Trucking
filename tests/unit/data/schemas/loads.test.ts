import { describe, expect, it } from "vitest";
import { createLoadSchema, updateLoadSchema } from "@/data/schemas/loads";

describe("createLoadSchema", () => {
  it("accepts a minimal valid load (origin + destination only, no dates/rate)", () => {
    const result = createLoadSchema.safeParse({ origin: "Dallas, TX", destination: "Miami, FL" });
    expect(result.success).toBe(true);
  });

  it("rejects a missing origin or destination", () => {
    expect(createLoadSchema.safeParse({ destination: "Miami, FL" }).success).toBe(false);
    expect(createLoadSchema.safeParse({ origin: "Dallas, TX" }).success).toBe(false);
  });

  it("accepts a delivery_date on or after pickup_date", () => {
    const result = createLoadSchema.safeParse({
      origin: "Dallas, TX",
      destination: "Miami, FL",
      pickup_date: "2026-08-21",
      delivery_date: "2026-08-23",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a delivery_date before pickup_date", () => {
    const result = createLoadSchema.safeParse({
      origin: "Dallas, TX",
      destination: "Miami, FL",
      pickup_date: "2026-08-23",
      delivery_date: "2026-08-21",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative rate_cents", () => {
    const result = createLoadSchema.safeParse({
      origin: "Dallas, TX",
      destination: "Miami, FL",
      rate_cents: -100,
    });
    expect(result.success).toBe(false);
  });
});

describe("updateLoadSchema", () => {
  it("allows a partial update", () => {
    expect(updateLoadSchema.safeParse({ status: "confirmed" }).success).toBe(true);
  });

  it("still enforces date ordering on a partial update when both dates are present", () => {
    const result = updateLoadSchema.safeParse({
      pickup_date: "2026-08-23",
      delivery_date: "2026-08-21",
    });
    expect(result.success).toBe(false);
  });
});
