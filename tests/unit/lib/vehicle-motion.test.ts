import { describe, expect, it } from "vitest";
import { classifyMotion, isRestricted, FIX_STALE_MS, MOVING_MPH } from "@/lib/vehicle-motion";

describe("classifyMotion - unknown never unlocks anything", () => {
  it("a fresh reading above the threshold is moving; at or below is stopped", () => {
    expect(classifyMotion(MOVING_MPH + 0.1, 1000)).toBe("moving");
    expect(classifyMotion(MOVING_MPH, 1000)).toBe("stopped");
    expect(classifyMotion(0, 0)).toBe("stopped");
  });

  it("no speed at all (null, undefined, NaN, negative) is unknown - not stopped", () => {
    for (const speed of [null, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(classifyMotion(speed as number | null | undefined, 1000)).toBe("unknown");
    }
  });

  it("a stale fix says nothing about now: unknown, even if it last read 0 mph", () => {
    expect(classifyMotion(0, FIX_STALE_MS + 1)).toBe("unknown");
    expect(classifyMotion(60, FIX_STALE_MS + 1)).toBe("unknown");
    expect(classifyMotion(0, null)).toBe("unknown");
    expect(classifyMotion(0, Number.NaN)).toBe("unknown");
  });

  it("only a positive 'stopped' is unrestricted", () => {
    expect(isRestricted("stopped")).toBe(false);
    expect(isRestricted("moving")).toBe(true);
    expect(isRestricted("unknown")).toBe(true);
  });
});
