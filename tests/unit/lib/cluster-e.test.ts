// Cluster E libs (GAP-15/16): IFTA worksheet honesty rules and
// the per-diem counting rule.

import { describe, expect, it } from "vitest";
import { buildIftaWorksheet, quarterOf, quarterRange } from "@/lib/ifta";
import { countPerDiemDays } from "@/lib/per-diem";
import type { DutyLog, FuelPurchase, Load } from "@/types/entities";

describe("GAP-15 IFTA", () => {
  it("quarters are calendar quarters", () => {
    expect(quarterOf("2026-11-02")).toBe("2026Q4");
    expect(quarterRange("2026Q1")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });

  it("gallons by state are exact; interstate miles stay unallocated", () => {
    const fuel = [
      { purchased_at: "2026-10-05T12:00:00Z", gallons: 100, state: "FL" },
      { purchased_at: "2026-10-20T12:00:00Z", gallons: 80, state: "GA" },
      { purchased_at: "2026-11-01T12:00:00Z", gallons: 50, state: null },
    ] as FuelPurchase[];
    const loads = [
      {
        status: "completed",
        delivery_date: "2026-10-06",
        miles: 300,
        origin_state: "FL",
        destination_state: "FL",
      },
      {
        status: "completed",
        delivery_date: "2026-10-21",
        miles: 900,
        origin_state: "GA",
        destination_state: "FL",
      },
    ] as Load[];
    const logs = [
      { started_at: "2026-10-01T12:00:00Z", odometer: 100_000 },
      { started_at: "2026-11-20T12:00:00Z", odometer: 109_000 },
    ] as DutyLog[];
    const sheet = buildIftaWorksheet("2026Q4", { fuel, loads, dutyLogs: logs });
    expect(sheet.gallonsByState).toEqual({ FL: 100, GA: 80 });
    expect(sheet.milesByState).toEqual({ FL: 300 });
    expect(sheet.unallocatedMiles).toBe(900);
    expect(sheet.fleetMpg).toBe(39.13); // 9000 odometer miles / 230 gallons
    expect(sheet.anomalies.some((a) => a.includes("no state recorded"))).toBe(true);
    expect(sheet.anomalies.some((a) => a.includes("can't be split by state"))).toBe(true);
  });
});

describe("GAP-16 per-diem", () => {
  const log = (started_at: string, duty_status: string, extra: Partial<DutyLog> = {}): DutyLog =>
    ({
      id: started_at,
      company_id: "c1",
      driver_id: null,
      load_id: null,
      duty_status,
      started_at,
      location: null,
      odometer: null,
      notes: null,
      created_at: started_at,
      updated_at: started_at,
      deleted_at: null,
      ...extra,
    }) as DutyLog;

  it("counts workdays away and road-reset nights, not the day he gets home", () => {
    const logs = [
      log("2026-03-02T12:00:00Z", "driving"), // Mon out
      log("2026-03-03T12:00:00Z", "driving"),
      log("2026-03-04T12:00:00Z", "driving"),
      // Thu: no logs (reset on the road) — counts via the gap rule.
      log("2026-03-06T12:00:00Z", "driving"), // Fri
      log("2026-03-06T23:00:00Z", "off_duty", { location: "Home" }), // home Friday night
    ];
    const count = countPerDiemDays(logs, 2026);
    // Mar 2,3,4 (work, away) + Mar 5 (reset night between workdays).
    // Mar 6 excluded: he ended that day at home.
    expect(count.awayDays).toBe(4);
    expect(count.awayDates).toContain("2026-03-05");
    expect(count.awayDates).not.toContain("2026-03-06");
    expect(count.estimatedDeductionCents).toBe(4 * count.rateCentsPerDay);
  });
});
