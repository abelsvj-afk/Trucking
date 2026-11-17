// Split-sleeper offer projection (owner 2026-11-17; docs/design/split-sleeper.md).
// Every number is worked out by hand from 49 CFR 395.1(g)(1)(ii):
// a pending first period + a second period taken starting now moves
// the window to the end of the FIRST period and keeps the driving
// already done against the 11 - a partial gain, never a fresh 11.
// A projection that fails (ii)(D) offers nothing.
import { describe, expect, it } from "vitest";
import { buildSegments } from "@/lib/hos";
import { computeHudClocks } from "@/lib/hud-clocks";
import { computeSplitOffer } from "@/lib/split-sleeper-offer";
import type { DutyStatus } from "@/types/entities";

const H = 3_600_000;
const T0 = Date.parse("2026-11-16T00:00:00Z");
function day(parts: [DutyStatus, number][]) {
  let t = T0;
  const rows = parts.map(([s, h]) => {
    const r = { duty_status: s, started_at: new Date(t).toISOString() };
    t += h * H;
    return r;
  });
  return { rows, end: t };
}
const offer = (rows: { duty_status: DutyStatus; started_at: string }[], now: number) =>
  computeSplitOffer(buildSegments(rows, now), now);

describe("split-sleeper offer", () => {
  it("owner's shape: 8h sleeper last night + 2h now -> window moves to the end of the sleeper, drive kept (not a fresh 11)", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 5], ["sleeper", 8], ["driving", 6], ["driving", 0]]);
    const o = offer(rows, end);
    expect(o).not.toBeNull();
    // He already drove 11h since the reset (5 + 6), so right now he has nothing left - but the split gives back
    // the 5h he drove BEFORE the sleeper, not a fresh 11.
    expect(o!.neededRestMs).toBe(2 * H);
    expect(o!.windowMovesToMs).toBe(T0 + (10 + 5 + 8) * H);
    expect(o!.driveLeftAfterMs).toBe(5 * H);
    expect(o!.windowLeftAfterMs).toBe(8 * H);
  });

  it("short first: 2h off first, then an 8h sleeper completes it", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 4], ["off_duty", 2], ["driving", 3], ["driving", 0]]);
    const o = offer(rows, end);
    expect(o).not.toBeNull();
    expect(o!.neededRestMs).toBe(8 * H);
    expect(o!.windowMovesToMs).toBe(T0 + (10 + 4 + 2) * H);
    expect(o!.driveLeftAfterMs).toBe(8 * H);
    expect(o!.windowLeftAfterMs).toBe(11 * H);
  });

  it("a projection that fails (ii)(D) offers nothing: 10h drive + 8h sleeper + 5h drive is 15h around the sleeper", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 10], ["sleeper", 8], ["driving", 5], ["driving", 0]]);
    expect(offer(rows, end)).toBeNull();
  });

  it("already paired -> no offer: the 8h + 2h pair is complete", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 5], ["sleeper", 8], ["driving", 3], ["off_duty", 2], ["driving", 0]]);
    expect(offer(rows, end)).toBeNull();
  });

  it("no pending period -> no offer", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 5], ["driving", 0]]);
    expect(offer(rows, end)).toBeNull();
  });

  it("already resting -> no offer: the rest under way is the answer, not a second period to start", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 5], ["sleeper", 8]]);
    expect(offer(rows, end)).toBeNull();
  });

  it("HUD shows the offer when a limit is close, and only the quiet note when it is not", () => {
    // Drive is used up (0 left): the offer is urgent.
    const urgent = day([["off_duty", 10], ["driving", 5], ["sleeper", 8], ["driving", 6], ["driving", 0]]);
    const urgentClocks = computeHudClocks(urgent.rows, null, urgent.end);
    expect(urgentClocks.state).toBe("ready");
    if (urgentClocks.state !== "ready") throw new Error("no clocks");
    expect(urgentClocks.splitOffer).toMatchObject({ neededRestMs: 2 * H, driveLeftAfterMs: 5 * H });
    // 8h drive and 3h window left: not urgent - the quiet split note stays, no popup offer.
    const calm = day([["off_duty", 10], ["driving", 2], ["sleeper", 8], ["driving", 1], ["driving", 0]]);
    const calmClocks = computeHudClocks(calm.rows, null, calm.end);
    expect(calmClocks.state).toBe("ready");
    if (calmClocks.state !== "ready") throw new Error("no clocks");
    expect(calmClocks.splitOffer).toBeNull();
    expect(calmClocks.split).toContain("first half");
  });
});
