import { describe, expect, it } from "vitest";
import { composeReminderMessage, evaluateReminders, type ReminderRow } from "@/lib/reminders";

const H = 3_600_000;
const NOW = Date.parse("2026-11-05T18:00:00Z");
const row = (status: ReminderRow["duty_status"], hoursAgo: number): ReminderRow => ({
  duty_status: status,
  started_at: new Date(NOW - hoursAgo * H).toISOString(),
});

describe("evaluateReminders - HOS (critical, immediate)", () => {
  it("30 minutes of driving time left raises one critical reminder, labeled planning-only", () => {
    const r = evaluateReminders([row("off_duty", 30), row("driving", 10.5)], NOW).filter((x) => x.key.startsWith("hos:drive"));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "hos", critical: true });
    expect(r[0]!.text).toContain("30 minutes of driving time left");
    expect(r[0]!.text).toContain("not an ELD");
  });

  it("uses the tightest threshold reached (10 min, not 30) and 0 means used up", () => {
    const ten = evaluateReminders([row("off_duty", 30), row("driving", 10 + 50 / 60)], NOW).find((x) => x.key.startsWith("hos:drive"));
    expect(ten!.key).toContain(":10:");
    const zero = evaluateReminders([row("off_duty", 30), row("driving", 11.2)], NOW).find((x) => x.key.startsWith("hos:drive"));
    expect(zero!.key).toContain(":0:");
    expect(zero!.text).toContain("used up");
  });

  it("the key is stable for the same window (so it is never sent twice) and different for a new window", () => {
    const a = evaluateReminders([row("off_duty", 30), row("driving", 10.5)], NOW).find((x) => x.key.startsWith("hos:drive"))!;
    const later = evaluateReminders([row("off_duty", 30), row("driving", 10.5)], NOW + 60_000).find((x) => x.key.startsWith("hos:drive"))!;
    expect(later.key).toBe(a.key);
    const newWindow = evaluateReminders([row("sleeper", 40), row("on_duty", 10.4), row("driving", 10.3)], NOW).find((x) => x.key.startsWith("hos:drive"));
    expect(newWindow?.key).not.toBe(a.key);
  });

  it("no reminder when off duty, rested, plenty left, or with no logs", () => {
    expect(evaluateReminders([row("driving", 12), row("off_duty", 2)], NOW)).toEqual([]);
    expect(evaluateReminders([row("driving", 3)], NOW)).toEqual([]);
    expect(evaluateReminders([], NOW)).toEqual([]);
  });

  it("the break clock only counts while DRIVING (on duty does not raise a break reminder)", () => {
    const onDuty = evaluateReminders([row("off_duty", 30), row("driving", 7.6), row("on_duty", 0.1)], NOW);
    expect(onDuty.find((x) => x.key.startsWith("hos:break"))).toBeUndefined();
    const driving = evaluateReminders([row("off_duty", 30), row("driving", 7.6)], NOW);
    expect(driving.find((x) => x.key.startsWith("hos:break"))).toBeTruthy();
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
