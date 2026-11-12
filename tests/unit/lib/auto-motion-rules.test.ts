import { describe, expect, it } from "vitest";
import { judgeAutoMotion, MAX_DETECTION_AGE_MS } from "@/lib/auto-motion-rules";
import { formatClock } from "@/lib/display-zone";

const NOW = Date.parse("2026-11-06T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("judgeAutoMotion - the app may only ADD a Driving row from detection time forward", () => {
  const off = { duty_status: "off_duty" as const, started_at: iso(NOW - 3 * 3600_000) };
  it("allows it when the log is non-driving and the newest row predates the detection", () => {
    expect(judgeAutoMotion(off, iso(NOW - 30_000), NOW)).toEqual({ ok: true });
  });
  it("stands down when already Driving", () => {
    expect(judgeAutoMotion({ duty_status: "driving", started_at: iso(NOW - 3600_000) }, iso(NOW - 30_000), NOW)).toEqual({ ok: false, reason: "already_driving" });
  });
  it("stands down when a manual change was logged at/after the detection (race: manual wins)", () => {
    expect(judgeAutoMotion({ duty_status: "on_duty", started_at: iso(NOW - 10_000) }, iso(NOW - 30_000), NOW)).toEqual({ ok: false, reason: "manual_change_won" });
    expect(judgeAutoMotion({ duty_status: "on_duty", started_at: iso(NOW - 30_000) }, iso(NOW - 30_000), NOW)).toEqual({ ok: false, reason: "manual_change_won" });
  });
  it("stands down when the driver logged a non-driving status DURING the motion run (their deliberate choice)", () => {
    // detection 30 s ago => the move began 90 s ago; a row 60 s ago is inside the run
    expect(judgeAutoMotion({ duty_status: "on_duty", started_at: iso(NOW - 60_000) }, iso(NOW - 30_000), NOW)).toEqual({ ok: false, reason: "manual_change_won" });
    expect(judgeAutoMotion({ duty_status: "on_duty", started_at: iso(NOW - 120_000) }, iso(NOW - 30_000), NOW)).toEqual({ ok: true });
  });
  it("never assumes a status for an empty log", () => {
    expect(judgeAutoMotion(null, iso(NOW - 30_000), NOW)).toEqual({ ok: false, reason: "no_status" });
  });
  it("refuses a future, stale or unreadable detection time", () => {
    expect(judgeAutoMotion(off, iso(NOW + 5 * 60_000), NOW)).toEqual({ ok: false, reason: "detection_in_future" });
    expect(judgeAutoMotion(off, iso(NOW - MAX_DETECTION_AGE_MS - 1000), NOW)).toEqual({ ok: false, reason: "detection_too_old" });
    expect(judgeAutoMotion(off, "nonsense", NOW)).toEqual({ ok: false, reason: "bad_time" });
  });
});

describe("formatClock (replaces easternClock, timezone transitions 2026-11-11)", () => {
  it("is Eastern with an ET label, never UTC, in the home zone", () => {
    expect(formatClock("2026-11-06T20:42:00Z", "America/New_York")).toBe("3:42 PM ET");
  });
  it("renders the same instant in Central with a CT label", () => {
    expect(formatClock("2026-11-06T20:42:00Z", "America/Chicago")).toBe("2:42 PM CT");
  });
});
