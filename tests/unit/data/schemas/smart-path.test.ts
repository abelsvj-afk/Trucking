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

// Piece 1 additions (P1-7 deadhead start, P1-9 life preferences):
// all optional, absence must parse exactly as the request did before.
describe("routeCheckRequestSchema - Piece 1 additions", () => {
  it("accepts the deadhead start fields", () => {
    const result = routeCheckRequestSchema.safeParse({
      load_id: LOAD_ID,
      depart_at: "2026-11-02T10:00:00.000Z",
      start_location: "Melbourne, FL",
      start_point: { lat: 28.08, lng: -80.6 },
      start_at: "2026-11-02T06:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.start_location).toBe("Melbourne, FL");
      expect(result.data.start_point).toEqual({ lat: 28.08, lng: -80.6 });
      expect(result.data.start_at).toBe("2026-11-02T06:00:00.000Z");
    }
  });

  it("rejects an out-of-range start_point lat/lng", () => {
    for (const start_point of [
      { lat: 91, lng: 0 },
      { lat: -91, lng: 0 },
      { lat: 0, lng: 181 },
      { lat: 0, lng: -181 },
    ]) {
      expect(
        routeCheckRequestSchema.safeParse({
          load_id: LOAD_ID,
          depart_at: "2026-11-02T10:00:00.000Z",
          start_point,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts the life object and defaults the workout fields", () => {
    const result = routeCheckRequestSchema.safeParse({
      load_id: LOAD_ID,
      depart_at: "2026-11-02T10:00:00.000Z",
      life: { sleep_start_hour: 22, sleep_end_hour: 6, workout: { want: true } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.life?.sleep_start_hour).toBe(22);
      expect(result.data.life?.sleep_end_hour).toBe(6);
      expect(result.data.life?.workout).toEqual({
        want: true,
        minutes: 60,
        setting: "gym_preferred",
      });
    }
  });

  it("rejects impossible life values", () => {
    expect(
      routeCheckRequestSchema.safeParse({
        load_id: LOAD_ID,
        depart_at: "2026-11-02T10:00:00.000Z",
        life: { sleep_start_hour: 24 },
      }).success,
    ).toBe(false);
    expect(
      routeCheckRequestSchema.safeParse({
        load_id: LOAD_ID,
        depart_at: "2026-11-02T10:00:00.000Z",
        life: { workout: { want: true, minutes: 10 } },
      }).success,
    ).toBe(false);
    expect(
      routeCheckRequestSchema.safeParse({
        load_id: LOAD_ID,
        depart_at: "2026-11-02T10:00:00.000Z",
        life: { workout: { want: true, setting: "hotel_gym" } },
      }).success,
    ).toBe(false);
  });

  it("parses a bare request identically to before - no Piece 1 keys appear", () => {
    const result = routeCheckRequestSchema.safeParse({
      load_id: LOAD_ID,
      depart_at: "2026-11-02T10:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        load_id: LOAD_ID,
        depart_at: "2026-11-02T10:00:00.000Z",
        food_mode: "grocery",
      });
      expect(result.data.start_location).toBeUndefined();
      expect(result.data.start_point).toBeUndefined();
      expect(result.data.start_at).toBeUndefined();
      expect(result.data.life).toBeUndefined();
    }
  });
});
