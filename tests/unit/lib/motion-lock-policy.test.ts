import { describe, expect, it } from "vitest";
import { MISMATCH_MAX_MPH, decideLock } from "@/lib/motion-lock-policy";
import type { MotionState } from "@/lib/vehicle-motion";

describe("decideLock - every motion x duty status", () => {
  const motions: MotionState[] = ["moving", "stopped", "unknown"];
  const duties = ["driving", "on_duty", "off_duty", "sleeper", "unknown"] as const;
  for (const motion of motions) {
    for (const duty of duties) {
      it(`${motion} / ${duty}`, () => {
        const slow = decideLock(motion, duty, 3);
        if (motion !== "moving") return expect(slow).toEqual({ kind: "none" });
        if (duty === "driving" || duty === "unknown") return expect(slow).toEqual({ kind: "lock" });
        expect(slow).toEqual({ kind: "mismatch", status: duty });
      });
    }
  }
  it("the speed floor: at/above the threshold or unknown speed locks even a non-driving status", () => {
    expect(decideLock("moving", "on_duty", MISMATCH_MAX_MPH - 0.1).kind).toBe("mismatch");
    expect(decideLock("moving", "on_duty", MISMATCH_MAX_MPH).kind).toBe("lock");
    expect(decideLock("moving", "sleeper", null).kind).toBe("lock");
    expect(decideLock("moving", "off_duty", Number.NaN).kind).toBe("lock");
  });
});
