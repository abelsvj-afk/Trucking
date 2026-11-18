// Detention (owner 2026-11-17). Fictional stops; times in Eastern.
import { describe, expect, it } from "vitest";
import { detentionReminders, detentionStartMs } from "@/services/bot/detention";

const ET = "America/New_York";
const stop = (over = {}) => ({ id: "s1", label: "Sample DC (Trip 9918)", arrivedAt: "2026-11-18T11:10:00Z", departedAt: null as string | null, appointmentAt: "2026-11-18T13:00:00Z" as string | null, ...over });

describe("detention", () => {
  it("free time runs 2 h from the appointment when he's early, from arrival when he's late", () => {
    expect(detentionStartMs(stop())).toBe(Date.parse("2026-11-18T15:00:00Z")); // early: appt 8 AM ET + 2 h
    expect(detentionStartMs(stop({ arrivedAt: "2026-11-18T14:00:00Z" }))).toBe(Date.parse("2026-11-18T16:00:00Z")); // late arrival
    expect(detentionStartMs(stop({ appointmentAt: null }))).toBe(Date.parse("2026-11-18T13:10:00Z"));
  });

  it("nothing before free time ends; then one message with a note for dispatch", () => {
    expect(detentionReminders(stop(), Date.parse("2026-11-18T14:59:00Z"), ET)).toEqual([]);
    const [r] = detentionReminders(stop(), Date.parse("2026-11-18T15:05:00Z"), ET);
    expect(r!.key).toBe("detention:s1");
    expect(r!.text).toContain("free hours ended 10:00 AM");
    expect(r!.text).toContain("Note for dispatch");
    expect(r!.text).toContain("since 6:10 AM for a 8:00 AM appointment");
  });

  it("when he leaves: the total, once", () => {
    const left = detentionReminders(stop({ departedAt: "2026-11-18T16:45:00Z" }), Date.parse("2026-11-18T16:50:00Z"), ET);
    expect(left.map((r) => r.key)).toEqual(["detention-end:s1"]);
    expect(left[0]!.text).toContain("1h 45m");
  });

  it("left inside free time: no detention at all", () => {
    expect(detentionReminders(stop({ departedAt: "2026-11-18T14:30:00Z" }), Date.parse("2026-11-18T14:40:00Z"), ET)).toEqual([]);
  });
});
