// GAP-08: the day-wrap's gap detection (pure pass).

import { describe, expect, it } from "vitest";
import { buildDayWrap, easternDate, type DayWrapInput } from "@/lib/day-wrap";
import type { DutyLog } from "@/types/entities";

function log(overrides: Partial<DutyLog>): DutyLog {
  return {
    id: "d1",
    company_id: "c1",
    driver_id: null,
    load_id: null,
    duty_status: "off_duty",
    started_at: "2026-11-02T12:00:00Z",
    location: null,
    odometer: null,
    notes: null,
    created_at: "2026-11-02T12:00:00Z",
    updated_at: "2026-11-02T12:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

function input(overrides: Partial<DayWrapInput> = {}): DayWrapInput {
  return {
    date: "2026-11-02",
    dutyLogs: [],
    odometerMilesToday: null,
    fuelLoggedToday: false,
    hasActiveLoad: false,
    paperwork: [],
    detention: [],
    pendingProposals: 0,
    now: new Date("2026-11-03T02:00:00Z"),
    ...overrides,
  };
}

describe("buildDayWrap", () => {
  it("flags a driving status left open for hours", () => {
    const items = buildDayWrap(
      input({
        dutyLogs: [log({ duty_status: "driving", started_at: "2026-11-02T20:00:00Z" })],
        hasActiveLoad: true,
      }),
    );
    expect(items.some((i) => i.kind === "duty" && i.severity === "gap")).toBe(true);
  });

  it("flags miles without fuel", () => {
    const items = buildDayWrap(
      input({
        dutyLogs: [log({ duty_status: "off_duty" })],
        odometerMilesToday: 612,
        fuelLoggedToday: false,
      }),
    );
    expect(items.some((i) => i.kind === "fuel")).toBe(true);
  });

  it("stays quiet about fuel when the miles are small", () => {
    const items = buildDayWrap(
      input({ dutyLogs: [log({})], odometerMilesToday: 40, fuelLoggedToday: false }),
    );
    expect(items.some((i) => i.kind === "fuel")).toBe(false);
  });

  it("reports detention owed and waiting proposals", () => {
    const items = buildDayWrap(
      input({
        dutyLogs: [log({})],
        detention: [
          {
            loadLabel: "Atlanta, GA → Wildwood, FL",
            summary: {
              totalBillableMinutes: 90,
              totalBillableHours: 2,
              freeMinutes: 120,
              freeMinutesAssumed: false,
              rateCentsPerHour: 7500,
              totalOwedCents: 15000,
              anyClockOpen: false,
              stops: [],
            },
          },
        ],
        pendingProposals: 3,
      }),
    );
    expect(items.some((i) => i.kind === "detention" && i.text.includes("$150.00"))).toBe(true);
    expect(items.some((i) => i.kind === "proposals")).toBe(true);
  });

  it("says the day checks out when nothing is missing", () => {
    const items = buildDayWrap(input({ dutyLogs: [log({})] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("ok");
  });
});

describe("easternDate", () => {
  it("buckets a late-evening UTC instant into the same ET day", () => {
    // 2026-11-03T02:30Z is 9:30 PM ET on Nov 2 (EST).
    expect(easternDate(new Date("2026-11-03T02:30:00Z"))).toBe("2026-11-02");
    expect(easternDate(new Date("2026-11-02T12:00:00Z"))).toBe("2026-11-02");
  });
});
