import { describe, expect, it } from "vitest";
import { buildDayWrap } from "@/lib/day-wrap";
import { buildDetentionClaimPack } from "@/lib/detention";
import type { DutyLog, Load } from "@/types/entities";

// KR-1 (King review of the steps 3–5 stack): user-facing times built
// on the server must render in America/New_York — the driver's day
// (project rule: no UTC in anything user-facing). Production runs
// with no TZ set (UTC in the container), so an unpinned formatter
// printed UTC wall-clock times: the day-wrap's "still driving"
// prompt misstated when his last duty change happened, and the
// detention claim pack quoted UTC stamp times to brokers.
// 2026-11-04T14:42:00Z is 9:42 AM EST. These tests pin the ET
// rendering regardless of the process timezone they run under.
describe("server-rendered user-facing times use America/New_York", () => {
  it("day-wrap 'still driving' line names the ET wall-clock time", () => {
    const started = "2026-11-04T14:42:00.000Z";
    const items = buildDayWrap({
      date: "2026-11-04",
      dutyLogs: [{ duty_status: "driving", started_at: started } as DutyLog],
      odometerMilesToday: null,
      fuelLoggedToday: true,
      hasActiveLoad: false,
      paperwork: [],
      detention: [],
      pendingProposals: 0,
      credentialAlerts: [],
      overdueInvoices: [],
      dueFollowups: [],
      now: new Date("2026-11-04T17:42:00.000Z"),
    });
    const duty = items.find((i) => i.kind === "duty");
    expect(duty?.text).toContain("9:42 AM");
  });

  it("detention claim pack stamps render in ET", () => {
    const pack = buildDetentionClaimPack({
      load: {
        origin: "Atlanta, GA",
        destination: "Charlotte, NC",
        detention_free_minutes: 120,
        detention_rate_cents_per_hour: 5000,
      } as Load,
      stamps: [
        { stop_kind: "pickup", stamp_type: "arrival", occurred_at: "2026-11-04T14:00:00.000Z" },
        { stop_kind: "pickup", stamp_type: "departure", occurred_at: "2026-11-04T17:30:00.000Z" },
      ] as never,
      documentLabels: [],
    });
    expect(pack).toContain("9:00 AM");
    expect(pack).toContain("12:30 PM");
  });
});
