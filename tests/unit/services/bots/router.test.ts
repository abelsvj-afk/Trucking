// Group routing: every bot hears the owner's messages; only the
// relevant one answers. Reply > mention > keyword > Abel.
// (Bots never hear each other — Telegram's own rule — so handoffs
// travel inside the app; mentionedBotByName finds them by NAME.)
import { describe, expect, it } from "vitest";
import { mentionedBotByName, routeGroupMessage, unseatedReply } from "@/services/bots/router";

describe("group routing", () => {
  it("routes a name mention to the named bot", () => {
    const route = routeGroupMessage({ text: "Abel, what is my pay this week?", senderKind: "owner" });
    expect(route.target).toBe("abel");
    expect(route.via).toBe("mention");
    expect(route.shouldAnswer).toBe(true);
  });

  it("routes load talk to Dispatch Scout by keyword", () => {
    const route = routeGroupMessage({ text: "find me a load to Dallas", senderKind: "owner" });
    expect(route.target).toBe("dispatch-scout");
    expect(route.via).toBe("keyword");
    expect(route.seated).toBe(true);
  });

  it("routes a reply to a bot's message back to that bot", () => {
    const route = routeGroupMessage({ text: "yes, take it", senderKind: "owner", replyToBotSlug: "dispatch-scout" });
    expect(route.target).toBe("dispatch-scout");
    expect(route.via).toBe("reply");
  });

  it("names the Auditor for a check, and the seat is wired in — the shared turn is the seat", () => {
    const route = routeGroupMessage({ text: "Auditor, check this math", senderKind: "owner" });
    expect(route.target).toBe("auditor");
    expect(route.seated).toBe(true);
    expect(unseatedReply("auditor")).toMatch(/isn't in the room yet/);
  });

  it("defaults everything else to Abel", () => {
    const route = routeGroupMessage({ text: "hey", senderKind: "owner" });
    expect(route.target).toBe("abel");
    expect(route.via).toBe("default");
    expect(route.shouldAnswer).toBe(true);
  });

  it("does not route a bot's own chatter to itself", () => {
    const route = routeGroupMessage({ text: "noted", senderKind: "bot", senderSlug: "abel" });
    expect(route.shouldAnswer).toBe(false);
  });

  it("finds a handoff by bot NAME, not by job words", () => {
    expect(mentionedBotByName("Tracker, take the ETA from here")).toBe("tracker");
    expect(mentionedBotByName("I'll dispatch this to the broker")).toBe(null);
    expect(mentionedBotByName("check the math on this one")).toBe(null);
    expect(mentionedBotByName("Auditor, does this add up?")).toBe("auditor");
    expect(mentionedBotByName("Tracker, take it", "tracker")).toBe(null);
  });
});
