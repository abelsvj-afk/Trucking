import { describe, expect, it } from "vitest";
import { parseStatusTalk } from "@/services/bot/status-talk";

describe("his words as a duty-status statement (owner transcript 2026-11-12)", () => {
  it("the line from the chat, and the common ways of saying it", () => {
    expect(parseStatusTalk("I'm off duty for 19 minutes so far")).toEqual({ status: "off_duty", minutesAgo: 19 });
    expect(parseStatusTalk("I'm off duty")).toEqual({ status: "off_duty", minutesAgo: 0 });
    expect(parseStatusTalk("been driving 2 hours")).toEqual({ status: "driving", minutesAgo: 120 });
    expect(parseStatusTalk("just went on duty")).toEqual({ status: "on_duty", minutesAgo: 0 });
    expect(parseStatusTalk("I'm in the sleeper")).toEqual({ status: "sleeper", minutesAgo: 0 });
    expect(parseStatusTalk("started driving half an hour ago")).toEqual({ status: "driving", minutesAgo: 30 });
  });

  it("questions, plans, negations and longer messages are left to the model", () => {
    for (const t of [
      "am I off duty?",
      "I'll be off duty at 5",
      "I'm not driving",
      "I'm going to be on duty tomorrow",
      "How are you",
      "the receiver said I'm off duty until the dock opens and then I need to back in at door 12 and wait for the lumper",
      "off duty",
    ]) {
      expect(parseStatusTalk(t), t).toBeNull();
    }
  });
});
