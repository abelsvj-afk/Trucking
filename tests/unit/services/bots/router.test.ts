// Group routing: every bot hears every message; only the relevant
// one answers. Reply > mention > keyword > Abel.
import { describe, expect, it } from "vitest";
import { routeGroupMessage, unseatedReply } from "@/services/bots/router";

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

  it("routes a medical card question to Compliance Watchdog by keyword", () => {
    const route = routeGroupMessage({ text: "when is my medical card due?", senderKind: "owner" });
    expect(route.target).toBe("compliance-watchdog");
    expect(route.via).toBe("keyword");
    expect(route.shouldAnswer).toBe(true);
    expect(route.seated).toBe(true);
  });

  it("routes a Watchdog mention and an hours question to Compliance Watchdog", () => {
    const mentioned = routeGroupMessage({ text: "Watchdog, check my deadlines", senderKind: "owner" });
    expect(mentioned.target).toBe("compliance-watchdog");
    expect(mentioned.via).toBe("mention");
    expect(mentioned.shouldAnswer).toBe(true);
    const hours = routeGroupMessage({ text: "how many hours do I have left?", senderKind: "owner" });
    expect(hours.target).toBe("compliance-watchdog");
    expect(hours.via).toBe("keyword");
  });

  it("routes a reply to a Watchdog message back to Watchdog", () => {
    const route = routeGroupMessage({ text: "got it", senderKind: "owner", replyToBotSlug: "compliance-watchdog" });
    expect(route.target).toBe("compliance-watchdog");
    expect(route.via).toBe("reply");
    expect(route.shouldAnswer).toBe(true);
  });

  it("does not route small talk to Watchdog", () => {
    const route = routeGroupMessage({ text: "hey", senderKind: "owner" });
    expect(route.target).toBe("abel");
    expect(route.via).toBe("default");
  });

  it("names the Auditor for a check, but marks the seat unseated in Phase 0", () => {
    const route = routeGroupMessage({ text: "Auditor, check this math", senderKind: "owner" });
    expect(route.target).toBe("auditor");
    expect(route.seated).toBe(false);
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
});
