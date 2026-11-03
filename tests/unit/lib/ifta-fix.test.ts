// UH-08 + UH-15 regression tests (union fix round).
import { describe, expect, it } from "vitest";
import { buildIftaWorksheet } from "@/lib/ifta";

describe("UH-08: IFTA odometer sanity gate", () => {
  it("a typo'd reading is excluded and flagged; no >1000 MPG is emitted", () => {
    const ws = buildIftaWorksheet("2026Q4", {
      fuel: [{ purchased_at: "2026-10-10", gallons: 100, state: "FL" } as never],
      loads: [],
      dutyLogs: [
        { started_at: "2026-10-05T12:00:00Z", odometer: 500_000 } as never,
        { started_at: "2026-10-20T12:00:00Z", odometer: 500_400 } as never,
        { started_at: "2026-11-01T12:00:00Z", odometer: 999_999 } as never,
      ],
    });
    expect(ws.odometerMiles).toBe(400);
    expect(ws.excludedOdometerReadings).toBe(1);
    expect(ws.fleetMpg).not.toBeNull();
    expect(ws.fleetMpg!).toBeLessThanOrEqual(15);
    expect(ws.anomalies.join(" ")).toMatch(/odometer/i);
  });
});

describe("UH-15: IFTA buckets by America/New_York dates", () => {
  it("a log at 02:00Z on Oct 1 (21:00 ET Sep 30) belongs to Q3, not Q4", () => {
    const ws = buildIftaWorksheet("2026Q4", {
      fuel: [{ purchased_at: "2026-10-10", gallons: 50, state: "FL" } as never],
      loads: [],
      dutyLogs: [
        { started_at: "2026-10-01T02:00:00Z", odometer: 100_000 } as never,
        { started_at: "2026-10-05T12:00:00Z", odometer: 100_300 } as never,
        { started_at: "2026-10-20T12:00:00Z", odometer: 100_600 } as never,
      ],
    });
    // The Sep-30-ET reading is out of Q4: spread is 300, not 600.
    expect(ws.odometerMiles).toBe(300);
    const ws3 = buildIftaWorksheet("2026Q3", {
      fuel: [],
      loads: [],
      dutyLogs: [
        { started_at: "2026-09-29T12:00:00Z", odometer: 99_700 } as never,
        { started_at: "2026-10-01T02:00:00Z", odometer: 100_000 } as never,
      ],
    });
    expect(ws3.odometerMiles).toBe(300);
  });
});
