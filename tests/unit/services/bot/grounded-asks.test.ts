import { describe, expect, it } from "vitest";
import { groundedAsksFor } from "@/services/bot/grounded-asks";
import { asksWhatIsWaiting } from "@/services/bot/agent-turn";

describe("which everyday asks are looked up in code", () => {
  it("hours", () => {
    for (const t of ["how many hours do I have", "what are my hours", "how much drive time do I have left", "can I still drive?"]) {
      expect(groundedAsksFor(t).map((a) => a.tool), t).toEqual(["hos_summary"]);
    }
  });
  it("next load", () => {
    for (const t of ["what's my next load", "where am I headed", "my next pickup?"]) {
      expect(groundedAsksFor(t).map((a) => a.tool), t).toEqual(["load_calendar"]);
    }
  });
  it("this month's pay and the goal", () => {
    for (const t of ["how much will I make this month", "am I at my goal yet", "do I have enough to go home"]) {
      expect(groundedAsksFor(t).map((a) => a.tool), t).toEqual(["monthly_income"]);
    }
  });
  it("plan my run / will I make it", () => {
    for (const t of ["plan my run", "will I make it on time?", "when will I get there", "where should I sleep tonight"]) {
      expect(groundedAsksFor(t).map((a) => a.tool), t).toEqual(["plan_my_run"]);
    }
  });
  it("small talk and long messages are left alone", () => {
    expect(groundedAsksFor("how are you doing")).toEqual([]);
    expect(groundedAsksFor("I will.")).toEqual([]);
    expect(groundedAsksFor("x".repeat(200) + " hours left")).toEqual([]);
  });
  it("what's waiting", () => {
    for (const t of ["What's waiting on me?", "anything pending", "what do I need to approve"]) expect(asksWhatIsWaiting(t), t).toBe(true);
    expect(asksWhatIsWaiting("waiting at the shipper, door 12")).toBe(false);
  });
});
