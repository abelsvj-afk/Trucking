// The 5-minute stop-prompt rule, tested against its live implementation.
// stopPromptDue (stopped-vehicle.ts) was deleted (audit-fix 2026-11-18):
// the check lives in decideAuto's "still_driving_prompt" branch, which
// MotionLock calls every tick. These cases are the deleted helper's tests,
// retargeted — the rule itself is unchanged and still covered.
import { describe, expect, it } from "vitest";
import { decideAuto } from "@/lib/auto-switch";
import { STATIONARY_PROMPT_MS, type SustainedState } from "@/lib/sustained-motion";

const T0 = 1_800_000_000_000;

const stopped = (sinceMs: number, nowMs: number): SustainedState => ({
  movingSinceMs: null,
  lastMovingFixAtMs: null,
  stoppedSinceMs: sinceMs,
  lastFixAtMs: nowMs,
});

describe("decideAuto — Driving + stationary 5 min prompts", () => {
  it("prompts at 5 min stopped while the log says Driving", () => {
    expect(decideAuto("driving", stopped(T0, T0 + STATIONARY_PROMPT_MS), T0 + STATIONARY_PROMPT_MS)).toEqual({
      kind: "still_driving_prompt",
      stoppedForMs: STATIONARY_PROMPT_MS,
    });
    expect(
      decideAuto("driving", stopped(T0, T0 + STATIONARY_PROMPT_MS - 1), T0 + STATIONARY_PROMPT_MS - 1).kind,
    ).toBe("none");
  });

  it("never prompts when not Driving, or with no stop episode", () => {
    expect(decideAuto("on_duty", stopped(T0, T0 + 60 * 60_000), T0 + 60 * 60_000).kind).toBe("none");
    expect(
      decideAuto(
        "driving",
        { movingSinceMs: null, lastMovingFixAtMs: null, stoppedSinceMs: null, lastFixAtMs: T0 + 60 * 60_000 },
        T0 + 60 * 60_000,
      ).kind,
    ).toBe("none");
  });
});
