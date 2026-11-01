// Gaming System request schemas (docs/design/gaming-system.md
// §§1/2.3): the API boundary rejects what the engine must never
// see - unknown override keys (strict), uncited side levers, and
// out-of-range posture values.

import { describe, expect, it } from "vitest";
import {
  createGameTargetSchema,
  gameOverridesSchema,
  promoteRequestSchema,
  updateGameTargetSchema,
  whatIfRequestSchema,
} from "@/data/schemas/game";

describe("game target schemas", () => {
  it("accepts a minimal target with the design's default metric", () => {
    const parsed = createGameTargetSchema.parse({
      metric: "monthly_net_cents",
      target_value_cents: 1_000_000,
      posture: "conservative",
    });
    expect(parsed.metric).toBe("monthly_net_cents");
  });

  it("rejects an unknown metric and an out-of-range slider", () => {
    expect(() =>
      createGameTargetSchema.parse({ metric: "vibes", target_value_cents: 100, posture: "conservative" }),
    ).toThrow();
    expect(() =>
      createGameTargetSchema.parse({
        metric: "monthly_net_cents",
        target_value_cents: 100,
        posture: "mixed",
        posture_mix_pct: 101,
      }),
    ).toThrow();
  });

  it("rejects a malformed target date", () => {
    expect(() =>
      createGameTargetSchema.parse({
        metric: "monthly_net_cents",
        target_value_cents: 100,
        target_date: "next spring",
        posture: "conservative",
      }),
    ).toThrow();
  });

  it("update schema allows partial edits but no empty write", () => {
    expect(updateGameTargetSchema.parse({ posture_mix_pct: 40 }).posture_mix_pct).toBe(40);
    expect(() => updateGameTargetSchema.parse({})).toThrow();
  });
});

describe("what-if overrides", () => {
  it("accepts engine keys and a cited lever", () => {
    const parsed = whatIfRequestSchema.parse({
      overrides: {
        fuel_price_cents_gal: 625,
        side_income_levers: [
          {
            key: "detailing",
            label: "Weekend detailing",
            sourceType: "briefing",
            sourceId: "b-1",
            monthlyLowCents: 40_000,
            monthlyHighCents: 60_000,
            hoursPerWeek: 4,
            startupCents: 0,
          },
        ],
      },
    });
    expect(parsed.overrides.fuel_price_cents_gal).toBe(625);
  });

  it("rejects unknown override keys outright (strict)", () => {
    expect(() => gameOverridesSchema.parse({ made_up_lever_cents: 5 })).toThrow();
  });

  it("rejects a side lever with no citation", () => {
    expect(() =>
      gameOverridesSchema.parse({
        side_income_levers: [{ key: "x", label: "X", monthlyLowCents: 1, monthlyHighCents: 2 }],
      }),
    ).toThrow();
  });

  it("promote requires a plan id", () => {
    expect(promoteRequestSchema.parse({ plan_id: "00000000-0000-0000-0000-000000000000" }).plan_id).toContain("-");
    expect(() => promoteRequestSchema.parse({ plan_id: "nope" })).toThrow();
  });
});
