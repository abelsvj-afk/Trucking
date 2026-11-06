import { describe, expect, it } from "vitest";
import { composeReminderMessage, evaluateReminders, type ReminderRow } from "@/lib/reminders";
import { computeHudClocks } from "@/lib/hud-clocks";

const H = 3_600_000;
const NOW = Date.parse("2026-11-05T18:00:00Z");
const row = (status: ReminderRow["duty_status"], hoursAgo: number): ReminderRow => ({
  duty_status: status,
  started_at: new Date(NOW - hoursAgo * H).toISOString(),
});

describe("evaluateReminders - HOS (critical, immediate): 2 h, 1 h, 30 min, expiry", () => {
  it("30 minutes of driving time left raises one critical reminder with the consequence and the action", () => {
    const r = evaluateReminders([row("off_duty", 30), row("driving", 10.5)], NOW).filter((x) => x.key.startsWith("hos:drive"));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "hos", critical: true });
    expect(r[0]!.text).toContain("about 30 minutes of driving left");
    expect(r[0]!.text).toContain("can't drive until you've had 10 straight hours off");
    expect(r[0]!.text).toContain("plan where you'll park");
    expect(r[0]!.text).toContain("not an ELD");
  });

  it("each threshold is its own message: 2 h, 1 h, 30 min, expiry - and the tightest reached wins", () => {
    const at = (hoursDriven: number) => evaluateReminders([row("off_duty", 30), row("driving", hoursDriven)], NOW).find((x) => x.key.startsWith("hos:drive"));
    expect(at(8.5)).toBeUndefined(); // 2.5 h left: nothing yet
    expect(at(9)!.key).toContain(":120:"); // exactly 2 h left
    expect(at(9.5)!.key).toContain(":120:");
    expect(at(10.2)!.key).toContain(":60:");
    expect(at(10.6)!.key).toContain(":30:");
    expect(at(11.2)!.key).toContain(":0:");
    expect(at(11.2)!.text).toContain("used all 11 hours of driving");
    expect(at(9)!.text).toContain("about 2 hours");
    expect(at(10.2)!.text).toContain("about 1 hour");
  });

  it("the key is stable for the same shift (so it is never sent twice) and different for a new shift", () => {
    const a = evaluateReminders([row("off_duty", 30), row("driving", 10.5)], NOW).find((x) => x.key.startsWith("hos:drive"))!;
    const later = evaluateReminders([row("off_duty", 30), row("driving", 10.5)], NOW + 60_000).find((x) => x.key.startsWith("hos:drive"))!;
    expect(later.key).toBe(a.key);
    const newWindow = evaluateReminders([row("sleeper", 40), row("on_duty", 10.4), row("driving", 10.3)], NOW).find((x) => x.key.startsWith("hos:drive"));
    expect(newWindow?.key).not.toBe(a.key);
  });

  it("the 14-hour window announces itself on any time, even off duty, until it ends", () => {
    const w = evaluateReminders([row("off_duty", 30), row("on_duty", 13), row("off_duty", 1.5)], NOW).find((x) => x.key.startsWith("hos:window"));
    expect(w).toBeTruthy();
    expect(w!.text).toContain("keeps running even when you're not driving");
    // already ended and he is parked off duty: nothing to say
    expect(evaluateReminders([row("off_duty", 30), row("on_duty", 16), row("off_duty", 1)], NOW).find((x) => x.key.startsWith("hos:window"))).toBeUndefined();
  });

  it("the cycle clock is announced from the server's cycle summary, with the restart explained", () => {
    const cycle = { cycle: "70/8", cycleLimitMinutes: 4200, periodAnchor: "00:00", restartEnabled: true, carrierTimeZone: "America/New_York", windowStart: "x", windowEnd: new Date(NOW).toISOString(), currentPeriodStart: "2026-11-05T05:00:00.000Z", onDutyMinutesInCycle: 4200 - 25, restartApplied: null, restartUnverified: false, warnings: [] } as never;
    const r = evaluateReminders([row("off_duty", 30), row("on_duty", 3)], NOW, cycle).find((x) => x.key.startsWith("hos:cycle"));
    expect(r!.key).toContain(":30:");
    expect(r!.key).toContain("2026-11-05T05:00:00.000Z");
    expect(r!.text).toContain("70/8");
    expect(r!.text).toContain("34 straight hours off");
    // no cycle summary -> the cycle clock is simply not announced
    expect(evaluateReminders([row("off_duty", 30), row("on_duty", 3)], NOW).find((x) => x.key.startsWith("hos:cycle"))).toBeUndefined();
  });

  it("every message is critical (quiet hours never hold it) and carries the planning-only label", () => {
    for (const hoursDriven of [9, 10.2, 10.6, 11.2]) {
      for (const r of evaluateReminders([row("off_duty", 30), row("driving", hoursDriven)], NOW).filter((x) => x.kind === "hos")) {
        expect(r.critical).toBe(true);
        expect(r.text).toContain("not an ELD");
      }
    }
  });

  it("no reminder when off duty and parked, rested, plenty left, or with no logs", () => {
    expect(evaluateReminders([row("driving", 22), row("off_duty", 11)], NOW)).toEqual([]); // rested 10+ h
    expect(evaluateReminders([row("driving", 3)], NOW)).toEqual([]);
    expect(evaluateReminders([], NOW)).toEqual([]);
  });

  it("the break clock only counts while DRIVING (on duty does not raise a break reminder)", () => {
    const onDuty = evaluateReminders([row("off_duty", 30), row("driving", 7.6), row("on_duty", 0.1)], NOW);
    expect(onDuty.find((x) => x.key.startsWith("hos:break"))).toBeUndefined();
    const driving = evaluateReminders([row("off_duty", 30), row("driving", 7.6)], NOW);
    expect(driving.find((x) => x.key.startsWith("hos:break"))).toBeTruthy();
    expect(driving.find((x) => x.key.startsWith("hos:break"))!.text).toContain("30 straight minutes not driving resets it");
  });
});

describe("evaluateReminders - stale status (routine)", () => {
  it("a status standing more than 14 h is probably out of date: a routine, non-critical question that changes nothing", () => {
    const r = evaluateReminders([row("off_duty", 40), row("driving", 15)], NOW).filter((x) => x.kind === "stale_status");
    expect(r).toHaveLength(1);
    expect(r[0]!.critical).toBe(false);
    expect(r[0]!.text).toContain("still says Driving");
    expect(r[0]!.text).toContain("ask before changing anything");
  });
  it("not raised for off duty / sleeper however long", () => {
    expect(evaluateReminders([row("sleeper", 30)], NOW).filter((x) => x.kind === "stale_status")).toEqual([]);
  });
});

describe("composeReminderMessage", () => {
  it("critical lines come first", () => {
    const msg = composeReminderMessage([
      { kind: "stale_status", key: "s", critical: false, text: "STALE" },
      { kind: "hos", key: "h", critical: true, text: "HOS" },
    ]);
    expect(msg.indexOf("HOS")).toBeLessThan(msg.indexOf("STALE"));
  });
});

describe("ring colours and notifications come from the SAME read and never disagree (Block B)", () => {
  it("amber <=> the 2 h notification exists; red <=> the 30 min notification; expired <=> the expiry notification", () => {
    for (const hoursDriven of [5, 8.9, 9, 9.9, 10, 10.4, 10.5, 10.9, 11, 11.5]) {
      const rows = [row("off_duty", 30), row("driving", hoursDriven)];
      const clocks = computeHudClocks(rows, null, NOW);
      if (clocks.state !== "ready") throw new Error("no clocks");
      const drive = clocks.clocks.find((c) => c.key === "drive")!;
      const reminder = evaluateReminders(rows, NOW).find((x) => x.key.startsWith("hos:drive"));
      const threshold = reminder ? Number(reminder.key.split(":")[2]) : null;
      if (drive.tone === "ok") expect(threshold).toBeNull();
      if (drive.tone === "warn") expect([120, 60]).toContain(threshold);
      if (drive.tone === "critical") expect(threshold).toBe(30);
      if (drive.tone === "expired") expect(threshold).toBe(0);
    }
  });
});
