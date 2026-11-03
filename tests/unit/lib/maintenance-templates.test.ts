// The interval library (Image Intelligence §5.1): the numbers
// Abel seeds from - pinned here so a silent edit to an interval
// is a visible test change, and the guesser (§5.4 fallback) maps
// ordinary shop talk to the right key or to nothing.

import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_TEMPLATES,
  guessTemplateKey,
  templateByKey,
} from "@/lib/maintenance-templates";

describe("MAINTENANCE_TEMPLATES — the §5.1 library, as designed", () => {
  it("carries exactly the design's eleven entries with its intervals", () => {
    const byKey = Object.fromEntries(MAINTENANCE_TEMPLATES.map((t) => [t.key, t]));
    expect(MAINTENANCE_TEMPLATES).toHaveLength(11);
    expect(byKey.engine_oil).toMatchObject({ intervalMiles: 15_000, intervalDays: 180 });
    expect(byKey.fuel_filters).toMatchObject({ intervalMiles: 15_000, intervalDays: 180 });
    expect(byKey.chassis_lube).toMatchObject({ intervalMiles: 15_000, intervalDays: 180 });
    expect(byKey.brake_inspection).toMatchObject({ intervalMiles: 15_000, intervalDays: 180 });
    expect(byKey.air_filter).toMatchObject({ intervalMiles: 30_000, intervalDays: 365 });
    expect(byKey.tire_inspection).toMatchObject({ intervalMiles: null, intervalDays: 30 });
    expect(byKey.coolant_test).toMatchObject({ intervalMiles: null, intervalDays: 180 });
    expect(byKey.belt_hose_inspect).toMatchObject({ intervalMiles: null, intervalDays: 365 });
    expect(byKey.dot_annual).toMatchObject({ intervalMiles: null, intervalDays: 365 });
    expect(byKey.dpf_service).toMatchObject({ intervalMiles: 250_000, intervalDays: null });
    expect(byKey.trans_diff_fluid).toMatchObject({ intervalMiles: 250_000, intervalDays: null });
  });

  it("marks exactly the safety/legal three as safety items", () => {
    const safety = MAINTENANCE_TEMPLATES.filter((t) => t.safety).map((t) => t.key).sort();
    expect(safety).toEqual(["brake_inspection", "dot_annual", "tire_inspection"]);
  });

  it("every entry has at least one interval and a unique key", () => {
    const keys = new Set(MAINTENANCE_TEMPLATES.map((t) => t.key));
    expect(keys.size).toBe(MAINTENANCE_TEMPLATES.length);
    for (const t of MAINTENANCE_TEMPLATES) {
      expect(t.intervalMiles != null || t.intervalDays != null).toBe(true);
    }
  });

  it("templateByKey resolves known keys and nothing else", () => {
    expect(templateByKey("engine_oil")?.label).toBe("Engine oil & filter");
    expect(templateByKey("warp_drive")).toBeNull();
    expect(templateByKey(null)).toBeNull();
  });
});

describe("guessTemplateKey — the §5.4 fallback match", () => {
  it("maps ordinary shop talk to the right key", () => {
    expect(guessTemplateKey("Oil change and new filter at the TA")).toBe("engine_oil");
    expect(guessTemplateKey("Changed the fuel filters")).toBe("fuel_filters");
    expect(guessTemplateKey("DOT annual done at the shop")).toBe("dot_annual");
    expect(guessTemplateKey("Greased the chassis")).toBe("chassis_lube");
    expect(guessTemplateKey("DPF cleaned and baked")).toBe("dpf_service");
  });

  it("returns null rather than stretching to a match", () => {
    expect(guessTemplateKey("Replaced the alternator")).toBeNull();
    expect(guessTemplateKey("Washed the truck")).toBeNull();
    expect(guessTemplateKey("New steer tires mounted")).toBeNull();
  });
});
