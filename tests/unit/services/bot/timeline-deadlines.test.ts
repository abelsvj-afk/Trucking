import { describe, expect, it } from "vitest";
import { buildTimeline, type TimelineEvent } from "@/services/bot/timeline";
import { buildDeadlines, type DueItem } from "@/services/bot/deadlines";

const TODAY = "2026-11-07"; // Saturday

describe("buildTimeline", () => {
  const events: TimelineEvent[] = [
    { day: "2026-11-05", topic: "fuel", at: "2026-11-05T14:00:00Z", time: "9:00 AM", text: "⛽ Fuel $410.00" },
    { day: "2026-11-03", topic: "loads", text: "🚚 Pickup: Macon, GA → Tampa, FL" },
    { day: "2026-11-05", topic: "loads", text: "🚚 Delivered: Macon, GA → Tampa, FL" },
    { day: "2026-11-05", topic: "fuel", at: "2026-11-05T21:00:00Z", time: "4:00 PM", text: "⛽ Fuel $120.00" },
    { day: "2026-11-06", topic: "money", text: "🧾 Expense $88.00 (repairs)" },
  ];
  it("orders by day then time, one header per day with the weekday and how long ago", () => {
    const t = buildTimeline(events, TODAY).text.split("\n");
    expect(t[0]).toBe("📅 Tue, Nov 3 (4 days ago)");
    expect(t[1]).toBe("  🚚 Pickup: Macon, GA → Tampa, FL");
    expect(t).toContain("📅 Thu, Nov 5 (2 days ago)");
    expect(t.indexOf("  9:00 AM - ⛽ Fuel $410.00")).toBeLessThan(t.indexOf("  4:00 PM - ⛽ Fuel $120.00"));
    expect(t).toContain("📅 Fri, Nov 6 (yesterday)");
  });
  it("filters by topic", () => {
    const built = buildTimeline(events, TODAY, ["fuel"]);
    expect(built.count).toBe(2);
    expect(built.text).not.toContain("Pickup");
  });
  it("says so when nothing happened, and caps a long list with a note", () => {
    expect(buildTimeline([], TODAY).text).toBe("Nothing recorded in that window.");
    const many = Array.from({ length: 100 }, (_, i) => ({ day: "2026-11-05", topic: "money" as const, text: `🧾 Expense ${i}` }));
    const built = buildTimeline(many, TODAY);
    expect(built.truncated).toBe(true);
    expect(built.text).toMatch(/20 more events/);
  });
});

describe("buildDeadlines", () => {
  const items: DueItem[] = [
    { date: "2026-11-02", kind: "credential", text: "Medical card expires" },
    { date: "2026-11-09", kind: "bill", text: "Phone $95.00 due" },
    { date: "2026-11-07", kind: "maintenance", text: "Oil change due" },
    { date: "2026-11-08", kind: "load", text: "pickup Macon, GA → Tampa, FL" },
    { date: "2027-02-01", kind: "bill", text: "far future" },
  ];
  it("overdue first with how many days, then upcoming soonest-first with days left", () => {
    const built = buildDeadlines(items, TODAY, 30);
    const lines = built.text.split("\n");
    expect(lines[0]).toBe("🔴 OVERDUE");
    expect(lines[1]).toBe("  🪪 5 days overdue (Mon, Nov 2) - Medical card expires");
    expect(lines).toContain("  🔧 TODAY (Sat, Nov 7) - Oil change due");
    expect(lines).toContain("  🚚 tomorrow (Sun, Nov 8) - pickup Macon, GA → Tampa, FL");
    expect(lines).toContain("  🧾 in 2 days (Mon, Nov 9) - Phone $95.00 due");
    expect(built.text).not.toContain("far future");
    expect(lines.indexOf("  🔧 TODAY (Sat, Nov 7) - Oil change due")).toBeLessThan(lines.indexOf("  🧾 in 2 days (Mon, Nov 9) - Phone $95.00 due"));
    expect(built).toMatchObject({ overdue: 1, upcoming: 3 });
  });
  it("says so when nothing is due", () => {
    expect(buildDeadlines([], TODAY, 14).text).toBe("Nothing due or overdue in the next 14 days.");
  });
});
