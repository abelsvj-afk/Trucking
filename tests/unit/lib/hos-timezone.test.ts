// Timezone transitions (owner order 2026-11-11), TZ-B: HOS clocks
// count REAL ELAPSED time. Crossing a zone line must not add or lose
// an hour on any clock — the same duty instants, described once in
// Central wall time and once in Eastern wall time, must produce the
// same driving minutes, the same window start, and the same carrier
// period boundaries.

import { describe, expect, it } from "vitest";
import { buildSegments, findWindowStartMs, sumMinutes, type DutySegmentInput } from "@/lib/hos";
import { hosPeriodStartMs, PROVISIONAL_HOS_CONFIG } from "@/lib/hos-periods";
import { zonedInstant } from "@/lib/zoned-day";

// Driving Nov 9, 8:00 PM CT (= 9:00 PM ET) through Nov 10, 8:00 PM CT
// (= 9:00 PM ET): 24 hours of driving, spanning the CT->ET crossing
// the truck makes on the road between them.
const DRIVE_START_CT = zonedInstant("2026-11-09", "20:00", "America/Chicago").getTime();
const DRIVE_START_ET = zonedInstant("2026-11-09", "21:00", "America/New_York").getTime();
const DRIVE_END_CT = zonedInstant("2026-11-10", "20:00", "America/Chicago").getTime();
const DRIVE_END_ET = zonedInstant("2026-11-10", "21:00", "America/New_York").getTime();
const NOW = DRIVE_END_CT + 60_000;

function logs(startMs: number, endMs: number): DutySegmentInput[] {
  return [
    { duty_status: "driving", started_at: new Date(startMs).toISOString() },
    { duty_status: "on_duty", started_at: new Date(endMs).toISOString() },
  ];
}

describe("HOS elapsed time is identical across a zone jump (TZ-B)", () => {
  it("the Central and Eastern descriptions are the same instants", () => {
    expect(DRIVE_START_CT).toBe(DRIVE_START_ET);
    expect(DRIVE_END_CT).toBe(DRIVE_END_ET);
  });

  it("driving minutes are identical whether the log is read in CT or ET", () => {
    const inCt = buildSegments(logs(DRIVE_START_CT, DRIVE_END_CT), NOW);
    const inEt = buildSegments(logs(DRIVE_START_ET, DRIVE_END_ET), NOW);
    expect(sumMinutes(inCt, DRIVE_START_CT, NOW, ["driving"])).toBe(24 * 60);
    expect(sumMinutes(inEt, DRIVE_START_ET, NOW, ["driving"])).toBe(24 * 60);
    expect(sumMinutes(inCt, DRIVE_START_CT, NOW, ["driving"])).toBe(
      sumMinutes(inEt, DRIVE_START_ET, NOW, ["driving"]),
    );
  });

  it("the 14-hour window start is the same instant in both readings", () => {
    const inCt = buildSegments(logs(DRIVE_START_CT, DRIVE_END_CT), NOW);
    const inEt = buildSegments(logs(DRIVE_START_ET, DRIVE_END_ET), NOW);
    expect(findWindowStartMs(inCt)).toBe(DRIVE_START_CT);
    expect(findWindowStartMs(inEt)).toBe(DRIVE_START_ET);
    expect(findWindowStartMs(inCt)).toBe(findWindowStartMs(inEt));
  });

  it("a one-hour gain or loss would fail: the window elapsed is 24h, not 23h or 25h", () => {
    const segs = buildSegments(logs(DRIVE_START_CT, DRIVE_END_CT), NOW);
    const windowStart = findWindowStartMs(segs)!;
    expect(Math.round((NOW - windowStart) / 60_000)).toBe(24 * 60 + 1);
  });

  it("carrier period boundaries never move with the display zone", () => {
    // The boundary depends only on the carrier config (anchor + carrier
    // zone), never on where the truck or the phone currently is.
    const instant = Date.parse("2026-11-10T12:00:00Z");
    expect(hosPeriodStartMs(instant, PROVISIONAL_HOS_CONFIG)).toBe(
      hosPeriodStartMs(instant, { ...PROVISIONAL_HOS_CONFIG }),
    );
    // Midnight Eastern anchor: the period containing noon UTC Nov 10
    // starts at 00:00 Eastern Nov 10 = 05:00 UTC.
    expect(hosPeriodStartMs(instant, PROVISIONAL_HOS_CONFIG)).toBe(Date.parse("2026-11-10T05:00:00Z"));
  });
});
