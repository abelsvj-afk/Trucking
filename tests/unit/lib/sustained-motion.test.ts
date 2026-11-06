import { describe, expect, it } from "vitest";
import {
  NO_SUSTAINED,
  SUSTAIN_MS,
  STATIONARY_PROMPT_MS,
  movingForMs,
  stepSustained,
  stoppedForMs,
  type SustainedState,
  type SustainedFix,
} from "@/lib/sustained-motion";
import { AUTO_SWITCH_GRACE_MS, decideAuto } from "@/lib/auto-switch";

const run = (fixes: SustainedFix[]): SustainedState => fixes.reduce(stepSustained, NO_SUSTAINED);
const moving = (atMs: number, speedMph = 30): SustainedFix => ({ atMs, speedMph, estimator: "moving" });
const stopped = (atMs: number, speedMph: number | null = 0): SustainedFix => ({ atMs, speedMph, estimator: "stopped" });
/** One fix every 5 s from `from` to `to` inclusive. */
const every5 = (from: number, to: number, make: (t: number) => SustainedFix) => {
  const out: SustainedFix[] = [];
  for (let t = from; t <= to; t += 5_000) out.push(make(t));
  return out;
};

describe("sustained motion (hysteresis)", () => {
  it("counts only unbroken fixes at >= 5 mph that the estimator also calls moving", () => {
    const s = run(every5(0, 70_000, (t) => moving(t)));
    expect(movingForMs(s, 70_000)).toBe(70_000);
  });
  it("dock creep under 5 mph and jitter at a standstill never accumulate", () => {
    const creep = run(every5(0, 120_000, (t) => ({ atMs: t, speedMph: 3, estimator: "moving" as const })));
    expect(movingForMs(creep, 120_000)).toBe(0);
    const jitter = run(every5(0, 120_000, (t) => ({ atMs: t, speedMph: 7, estimator: "stopped" as const })));
    expect(movingForMs(jitter, 120_000)).toBe(0);
  });
  it("a short slow patch (stop-and-go) does not reset; a long one does", () => {
    const short = run([...every5(0, 30_000, (t) => moving(t)), { atMs: 38_000, speedMph: 2, estimator: "moving" }, moving(45_000)]);
    expect(movingForMs(short, 45_000)).toBe(45_000);
    const long = run([...every5(0, 30_000, (t) => moving(t)), { atMs: 40_000, speedMph: 2, estimator: "moving" }, { atMs: 50_000, speedMph: 2, estimator: "moving" }, moving(55_000)]);
    expect(movingForMs(long, 55_000)).toBe(0); // restarted at 55 s
    expect(long.movingSinceMs).toBe(55_000);
  });
  it("a GPS gap (tunnel) resets - no evidence is not motion", () => {
    const s = run([...every5(0, 30_000, (t) => moving(t)), moving(60_000)]);
    expect(s.movingSinceMs).toBe(60_000);
    expect(movingForMs(run(every5(0, 30_000, (t) => moving(t))), 80_000)).toBe(0);
  });
  it("standstill needs positive stopped fixes and resets on movement or a gap", () => {
    const s = run(every5(0, 300_000, (t) => stopped(t)));
    expect(stoppedForMs(s, 300_000)).toBe(300_000);
    expect(stoppedForMs(stepSustained(s, moving(305_000)), 305_000)).toBe(0);
    expect(stoppedForMs(s, 330_000)).toBe(0);
    expect(stoppedForMs(run(every5(0, 300_000, (t) => ({ atMs: t, speedMph: null, estimator: "unknown" as const }))), 300_000)).toBe(0);
  });
});

describe("decideAuto", () => {
  const sustained = (untilMs: number) => run(every5(0, untilMs, (t) => moving(t)));
  it("nothing before 60 s of sustained motion", () => {
    expect(decideAuto("off_duty", sustained(55_000), 55_000).kind).toBe("none");
  });
  it("detects at 60 s, with the grace deadline, stamped at the detection time", () => {
    const d = decideAuto("off_duty", sustained(60_000), 60_000);
    expect(d).toEqual({ kind: "detected", detectedAtMs: SUSTAIN_MS, autoSwitchAtMs: SUSTAIN_MS + AUTO_SWITCH_GRACE_MS });
  });
  it("auto-switches once the grace has passed with motion still sustained - detection time, not now", () => {
    const d = decideAuto("sleeper", sustained(90_000), 90_000);
    expect(d).toEqual({ kind: "auto_switch", detectedAtMs: SUSTAIN_MS });
  });
  it("motion that stops during the grace cancels the switch", () => {
    const s = run([...every5(0, 70_000, (t) => moving(t)), stopped(75_000)]);
    expect(decideAuto("on_duty", s, 95_000).kind).toBe("none");
  });
  it("a status the driver logged AFTER the motion began is deliberate: no automatic override (manual wins)", () => {
    const s = sustained(100_000);
    expect(decideAuto("on_duty", s, 100_000, 20_000).kind).toBe("none"); // logged 20 s into the move
    expect(decideAuto("on_duty", s, 100_000, -5_000).kind).toBe("auto_switch"); // logged before it began
    expect(decideAuto("on_duty", s, 100_000, null).kind).toBe("auto_switch");
  });
  it("never acts on an unknown status, and never auto-switches out of Driving", () => {
    expect(decideAuto("unknown", sustained(120_000), 120_000).kind).toBe("none");
    expect(decideAuto("driving", sustained(120_000), 120_000).kind).toBe("none");
  });
  it("Driving + stationary 5 min -> prompt only", () => {
    const s = run(every5(0, STATIONARY_PROMPT_MS, (t) => stopped(t)));
    expect(decideAuto("driving", s, STATIONARY_PROMPT_MS).kind).toBe("still_driving_prompt");
    expect(decideAuto("driving", run(every5(0, 240_000, (t) => stopped(t))), 240_000).kind).toBe("none");
  });
  it("a non-driving status that is stationary gets no stationary prompt", () => {
    const s = run(every5(0, STATIONARY_PROMPT_MS, (t) => stopped(t)));
    expect(decideAuto("off_duty", s, STATIONARY_PROMPT_MS).kind).toBe("none");
  });
});
