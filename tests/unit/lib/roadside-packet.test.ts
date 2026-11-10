// Roadside packet (docs/design/eld-roadside-overlay.md): the officer-facing
// text must carry the honest framing, the same clocks the HUD states, the
// 8-day Eastern look-back, and NO money data - and its Eastern-midnight
// math must hold on DST days.

import { describe, expect, it } from "vitest";
import { buildRoadsidePacket, easternMidnightMs, packetDays, packetPeriod, PACKET_FRAMING, type PacketDutyRow } from "@/lib/roadside-packet";
import { computeHudClocks, type HudDutyRow } from "@/lib/hud-clocks";
import type { DutyLogWindowSummary } from "@/types/hos-settings";

const H = 3_600_000;
const at = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse("2026-11-09T15:00:00Z"); // Mon Nov 9 2026, 10:00 AM EST

function summary(windowEndMs: number): DutyLogWindowSummary {
  return {
    cycle: "70/8",
    cycleLimitMinutes: 4200,
    periodAnchor: "00:00",
    restartEnabled: true,
    carrierTimeZone: "America/New_York",
    windowStart: at(windowEndMs - 8 * 24 * H),
    windowEnd: at(windowEndMs),
    currentPeriodStart: at(windowEndMs - 6 * H),
    onDutyMinutesInCycle: 600,
    restartApplied: null,
    restartUnverified: false,
    warnings: [],
  };
}

const rows: PacketDutyRow[] = [
  { duty_status: "off_duty", started_at: at(NOW - 30 * H) },
  { duty_status: "on_duty", started_at: at(NOW - 4 * H) },
  { duty_status: "driving", started_at: at(NOW - 3 * H), location: "Panama City, FL" },
];

function packet(nowMs = NOW) {
  const hudRows: HudDutyRow[] = rows.map((r) => ({ duty_status: r.duty_status, started_at: r.started_at }));
  return buildRoadsidePacket({
    driverName: "Test Driver",
    companyName: "Test Trucking LLC",
    rows,
    clocks: computeHudClocks(hudRows, summary(nowMs), nowMs),
    cycleLine: "Cycle (70 hr / 8 days): 10h 00m used.",
    now: new Date(nowMs),
  });
}

describe("packetPeriod / easternMidnightMs", () => {
  it("covers today + the previous 7 Eastern days", () => {
    expect(packetPeriod(new Date(NOW))).toEqual({ periodStart: "2026-11-02", periodEnd: "2026-11-09" });
  });

  it("Eastern midnight is 05:00Z in EST and 04:00Z in EDT", () => {
    expect(new Date(easternMidnightMs("2026-11-09")).toISOString()).toBe("2026-11-09T05:00:00.000Z");
    expect(new Date(easternMidnightMs("2026-07-09")).toISOString()).toBe("2026-07-09T04:00:00.000Z");
  });

  it("Eastern midnight holds on the spring-forward day", () => {
    // 2026-03-08: clocks jump 02:00 EST -> 03:00 EDT; midnight that day is EST (05:00Z).
    expect(new Date(easternMidnightMs("2026-03-08")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(easternMidnightMs("2026-03-09")).toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });
});

describe("buildRoadsidePacket", () => {
  it("carries the honest framing at the top AND the bottom", () => {
    const p = packet();
    expect(p.text.split(PACKET_FRAMING).length - 1).toBe(2);
    expect(p.text).toContain("carrier's ELD");
    expect(p.text).toContain("legal record");
  });

  it("states the driver, company, period and the same clocks as the HUD", () => {
    const p = packet();
    expect(p.text).toContain("Driver: Test Driver");
    expect(p.text).toContain("Company: Test Trucking LLC");
    expect(p.text).toContain("Cycle (70 hr / 8 days): 10h 00m used.");
    expect(p.text).toContain("Drive: 8:00:00 left of 11:00:00");
    expect(p.text).toContain("14-hour window: 10:00:00 left of 14:00:00");
    expect(p.text).toContain("Current duty status: Driving");
  });

  it("lists the day's segments in Eastern time with locations and totals", () => {
    const p = packet();
    expect(p.text).toContain("Driving");
    expect(p.text).toContain("(Panama City, FL)");
    expect(p.text).toMatch(/Day totals: driving 3h 00m, on duty 4h 00m\./);
  });

  it("never mentions money, pay or rates (none is even an input)", () => {
    const p = packet();
    expect(p.text).not.toMatch(/\$\s?\d|pay|rate|revenue|invoice/i);
  });

  it("says unavailable instead of inventing clocks when there are no logs", () => {
    const p = buildRoadsidePacket({
      driverName: null,
      companyName: null,
      rows: [],
      clocks: computeHudClocks([], null, NOW),
      cycleLine: "Cycle: no duty logs yet.",
      now: new Date(NOW),
    });
    expect(p.text).toContain("no duty logs recorded in this app");
    expect(p.text).toContain("(driver name not recorded in the app)");
  });

  it("splits a segment at Eastern midnight for the per-day view", () => {
    // Driving from 11 PM EST Nov 8 to 1 AM EST Nov 9.
    const start = Date.parse("2026-11-09T04:00:00Z");
    const splitRows: PacketDutyRow[] = [
      { duty_status: "off_duty", started_at: at(start - 20 * H) },
      { duty_status: "driving", started_at: at(start) },
      { duty_status: "off_duty", started_at: at(start + 2 * H) },
    ];
    const days = packetDays(splitRows, "2026-11-08", "2026-11-09", start + 3 * H);
    const nov8 = days.find((d) => d.date === "2026-11-08")!;
    const nov9 = days.find((d) => d.date === "2026-11-09")!;
    const drive8 = nov8.slices.filter((s) => s.status === "driving");
    const drive9 = nov9.slices.filter((s) => s.status === "driving");
    expect(drive8).toHaveLength(1);
    expect(drive9).toHaveLength(1);
    expect((drive8[0]!.endMs - drive8[0]!.startMs) / 3_600_000).toBe(1);
    expect((drive9[0]!.endMs - drive9[0]!.startMs) / 3_600_000).toBe(1);
  });
});
