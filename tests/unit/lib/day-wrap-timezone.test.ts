// Timezone transitions (owner order 2026-11-11): the day-wrap's one
// clock site — the open-driving duty gap — renders in the display zone
// with a label. Default stays labeled home Eastern.

import { describe, expect, it } from "vitest";
import { buildDayWrap, type DayWrapInput } from "@/lib/day-wrap";
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
    credentialAlerts: [],
    overdueInvoices: [],
    dueFollowups: [],
    now: new Date("2026-11-03T02:00:00Z"),
    ...overrides,
  };
}

describe("buildDayWrap duty-gap time in the display zone", () => {
  // Driving since 2026-11-02T20:00:00Z = 2:00 PM CT / 3:00 PM ET.
  const driving = [log({ duty_status: "driving", started_at: "2026-11-02T20:00:00Z" })];

  it("renders the open-driving time in Central with a CT label", () => {
    const items = buildDayWrap(input({ dutyLogs: driving, hasActiveLoad: true }), "America/Chicago");
    const duty = items.find((i) => i.kind === "duty")!;
    expect(duty.text).toContain("2:00 PM CT");
    expect(duty.text).not.toContain("ET");
    expect(duty.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults to labeled home Eastern when no zone is passed", () => {
    const items = buildDayWrap(input({ dutyLogs: driving, hasActiveLoad: true }));
    const duty = items.find((i) => i.kind === "duty")!;
    expect(duty.text).toContain("3:00 PM ET");
    expect(duty.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
