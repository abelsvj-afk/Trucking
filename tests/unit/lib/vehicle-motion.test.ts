import { describe, expect, it } from "vitest";
import { isRestricted } from "@/lib/vehicle-motion";

// classifyMotion / settleMotion were deleted (audit-fix 2026-11-18): the
// bubble estimator in motion-estimator.ts is the live classifier, and its
// own test file plus the useVehicleMotionDetail hook tests cover the same
// safety rules (unknown never unlocks, a stop must hold before unlocking).
describe("isRestricted - only a positive 'stopped' unlocks the fuller screen", () => {
  it("only a positive 'stopped' is unrestricted", () => {
    expect(isRestricted("stopped")).toBe(false);
    expect(isRestricted("moving")).toBe(true);
    expect(isRestricted("unknown")).toBe(true);
  });
});
