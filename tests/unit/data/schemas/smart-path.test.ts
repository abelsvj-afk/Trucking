// Smart Path v1 (docs/design/driver-mvp.md §8.3). The route-check
// request contract: reject malformed input before any provider or
// database call (CLAUDE.md's reject-don't-sanitize rule).

import { describe, expect, it } from "vitest";
import { routeCheckRequestSchema } from "@/data/schemas/smart-path";

const LOAD_ID = "3f6b8d5a-9c2e-4b7a-8d1f-2e5a6b7c8d9e";

describe("routeCheckRequestSchema", () => {
  it("accepts a minimal valid request and defaults food_mode to grocery", () => {
    const result = routeCheckRequestSchema.safeParse({
      load_id: LOAD_ID,
      depart_at: "2026-11-02T10:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.food_mode).toBe("grocery");
  });

  it("accepts windows and a gallons figure", () => {
    const result = routeCheckRequestSchema.safeParse({
      load_id: LOAD_ID,
      depart_at: "2026-11-02T10:00:00.000Z",
      delivery_window: { start: "2026-11-02T16:00:00.000Z", end: "2026-11-02T22:00:00.000Z" },
      food_mode: "fast_food",
      gallons_to_buy: 120,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid load_id", () => {
    const result = routeCheckRequestSchema.safeParse({
      load_id: "not-a-load",
      depart_at: "2026-11-02T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a window that ends before it starts", () => {
    const result = routeCheckRequestSchema.safeParse({
      load_id: LOAD_ID,
      depart_at: "2026-11-02T10:00:00.000Z",
      delivery_window: { start: "2026-11-02T22:00:00.000Z", end: "2026-11-02T16:00:00.000Z" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-timestamp depart_at and an absurd gallons figure", () => {
    expect(
      routeCheckRequestSchema.safeParse({ load_id: LOAD_ID, depart_at: "tomorrow morning" }).success,
    ).toBe(false);
    expect(
      routeCheckRequestSchema.safeParse({
        load_id: LOAD_ID,
        depart_at: "2026-11-02T10:00:00.000Z",
        gallons_to_buy: 900,
      }).success,
    ).toBe(false);
  });
});
