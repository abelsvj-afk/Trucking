// Owner 2026-11-17: "Auto Off Duty after 2h" - parked 2 h with no answer after the app's own automatic stop.
import { describe, expect, it } from "vitest";
import { AUTO_REST_AFTER_MS, judgeAutoRest } from "@/lib/auto-motion-rules";

const STOP = "2026-11-17T02:12:00.000Z";
const stopMs = Date.parse(STOP);
const autoOnDuty = { duty_status: "on_duty" as const, started_at: STOP, source: "auto_motion" };

describe("auto Off Duty after 2 hours parked", () => {
  it("follows the app's own automatic On Duty: Off Duty from when he parked (a second after the auto row)", () => {
    expect(judgeAutoRest(autoOnDuty, STOP, stopMs + AUTO_REST_AFTER_MS)).toEqual({ ok: true, startedAtMs: stopMs + 1000 });
  });
  it("still Driving after 2 h parked (the stop side never ran): Off Duty from the stop", () => {
    expect(judgeAutoRest({ duty_status: "driving", started_at: "2026-11-16T20:00:00Z" }, STOP, stopMs + 3 * 3_600_000)).toEqual({ ok: true, startedAtMs: stopMs });
  });
  it("never before 2 hours", () => {
    expect(judgeAutoRest(autoOnDuty, STOP, stopMs + AUTO_REST_AFTER_MS - 60_000)).toMatchObject({ ok: false, reason: "not_parked_long_enough" });
  });
  it("an On Duty he set himself (loading at a dock) is never overridden", () => {
    expect(judgeAutoRest({ ...autoOnDuty, source: "app" }, STOP, stopMs + 5 * 3_600_000)).toMatchObject({ ok: false, reason: "manual_status" });
    expect(judgeAutoRest({ ...autoOnDuty, source: null }, STOP, stopMs + 5 * 3_600_000)).toMatchObject({ ok: false, reason: "manual_status" });
  });
  it("already resting, a row from a different stop, or a day-old park: nothing", () => {
    expect(judgeAutoRest({ duty_status: "sleeper", started_at: STOP }, STOP, stopMs + 5 * 3_600_000)).toMatchObject({ reason: "already_resting" });
    expect(judgeAutoRest({ ...autoOnDuty, started_at: "2026-11-17T04:00:00Z" }, STOP, stopMs + 5 * 3_600_000)).toMatchObject({ reason: "row_after_stop" });
    expect(judgeAutoRest(autoOnDuty, STOP, stopMs + 25 * 3_600_000)).toMatchObject({ reason: "stop_too_old" });
  });
});
