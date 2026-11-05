import { describe, expect, it } from "vitest";
import { NO_ESTIMATE, motionState, stepMotion, type MotionEstimate, type MotionFix } from "@/lib/motion-estimator";

const M = 1 / 111_320; // degrees of latitude per metre
const T0 = 1_000_000;
const fix = (northM: number, eastM: number, tSec: number, speedMph: number | null, accuracyM = 10): MotionFix => ({
  lat: 28 + northM * M, lng: -81.7 + (eastM * M) / Math.cos((28 * Math.PI) / 180), accuracyM, atMs: T0 + tSec * 1000, speedMph,
});
const run = (fixes: MotionFix[], start: MotionEstimate = NO_ESTIMATE) => fixes.reduce(stepMotion, start);

describe("a parked phone that fidgets stays stopped", () => {
  it("wander of ~15 m with small non-zero speeds and an occasional spike settles to stopped and never flips to moving", () => {
    const wander: Array<[number, number, number]> = [[0,0,0],[8,4,1],[-6,10,0],[12,-9,2],[-14,3,6],[5,-12,1],[9,9,0],[-10,-8,3],[3,14,7],[-8,2,0],[6,-5,1],[0,0,0]];
    let est = NO_ESTIMATE;
    for (let i = 0; i < 40; i++) {
      const [n, e, s] = wander[i % wander.length]!;
      est = stepMotion(est, fix(n, e, i, s));
      expect(est.moving).toBe(false);
    }
    expect(motionState(est, T0 + 40_000)).toBe("stopped");
  });

  it("a phone that reports NO speed while parked is positively stopped from steady fixes - not 'unknown'", () => {
    let est = NO_ESTIMATE;
    for (let i = 0; i < 15; i++) est = stepMotion(est, fix((i % 3) * 4, (i % 2) * 5, i, null));
    expect(motionState(est, T0 + 15_000)).toBe("stopped");
  });

  it("the drawn icon is pinned (does not jitter) while parked", () => {
    let est = NO_ESTIMATE;
    const pts = new Set<string>();
    for (let i = 0; i < 12; i++) {
      est = stepMotion(est, fix(i % 2 ? 9 : -9, i % 3 ? 7 : -7, i, 1));
      if (i >= 2) pts.add(`${est.displayPoint!.lat.toFixed(7)},${est.displayPoint!.lng.toFixed(7)}`);
    }
    expect(pts.size).toBe(1);
  });

  it("slow drift past the bubble with a reported low speed is followed, not treated as driving", () => {
    let est = NO_ESTIMATE;
    for (let i = 0; i < 60; i++) est = stepMotion(est, fix(i * 2, 0, i, 1)); // 120 m of drift at ~2 m/s reported 1 mph
    expect(est.moving).toBe(false);
  });
});

describe("real movement is still caught quickly", () => {
  const parked = () => run(Array.from({ length: 14 }, (_, i) => fix(0, 0, i, 0)));

  it("one good fix at truck speed is moving at once", () => {
    const est = stepMotion(parked(), fix(10, 0, 14, 25));
    expect(est.moving).toBe(true);
    expect(motionState(est, T0 + 14_000)).toBe("moving");
  });

  it("a single spike inside the bubble is ignored, two clearly-moving fixes are not", () => {
    const one = stepMotion(parked(), fix(2, 0, 14, 9));
    expect(one.moving).toBe(false);
    expect(stepMotion(one, fix(4, 0, 15, 10)).moving).toBe(true);
  });

  it("pulling away with NO speed reported: two fixes outside the bubble say moving", () => {
    let est = parked();
    est = stepMotion(est, fix(45, 0, 14, null));
    expect(est.moving).toBe(false); // one jump could be a glitch
    est = stepMotion(est, fix(90, 0, 15, null));
    expect(est.moving).toBe(true);
  });

  it("after moving, a new stop needs low speed and then holds 10 s before unlocking", () => {
    let est = stepMotion(parked(), fix(10, 0, 14, 40));
    est = stepMotion(est, fix(300, 0, 20, 2));
    expect(est.moving).toBe(false);
    expect(motionState(est, T0 + 22_000)).toBe("moving"); // not yet settled
    expect(motionState(est, T0 + 31_000)).toBe("stopped"); // held 10+ s... but fix is 11 s old: still fresh (<15 s)
  });
});

describe("cold start", () => {
  it("opened while already parked: stopped after ~3 s of steady fixes, not the 10 s traffic-lull hold", () => {
    let est = stepMotion(NO_ESTIMATE, fix(0, 0, 0, 0));
    est = stepMotion(est, fix(2, 1, 3, 0));
    expect(motionState(est, T0 + 2_000)).toBe("moving");
    expect(motionState(est, T0 + 3_500)).toBe("stopped");
  });
  it("once movement has been seen, the full 10 s hold applies again", () => {
    let est = stepMotion(NO_ESTIMATE, fix(0, 0, 0, 30));
    est = stepMotion(est, fix(50, 0, 3, 0));
    expect(est.neverMoved).toBe(false);
    expect(motionState(est, T0 + 8_000)).toBe("moving");
    expect(motionState(est, T0 + 14_000)).toBe("stopped");
  });
});

describe("fail closed", () => {
  it("no fix, a stale fix, or only poor fixes are unknown - never stopped", () => {
    expect(motionState(NO_ESTIMATE, T0)).toBe("unknown");
    const est = run(Array.from({ length: 14 }, (_, i) => fix(0, 0, i, 0)));
    expect(motionState(est, T0 + 13_000 + 16_000)).toBe("unknown");
    const poor = run(Array.from({ length: 14 }, (_, i) => fix(0, 0, i, 0, 400)));
    expect(poor).toBe(NO_ESTIMATE);
  });

  it("a poor fix mid-stop changes nothing", () => {
    const est = run(Array.from({ length: 12 }, (_, i) => fix(0, 0, i, 0)));
    expect(stepMotion(est, fix(500, 500, 12, 40, 300))).toBe(est);
  });
});
