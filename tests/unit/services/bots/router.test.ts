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

  it("seats the Auditor now that its branch wires it in — a name mention answers", () => {
    const route = routeGroupMessage({ text: "Auditor, check this math", senderKind: "owner" });
    expect(route.target).toBe("auditor");
    expect(route.via).toBe("mention");
    expect(route.seated).toBe(true);
    expect(route.shouldAnswer).toBe(true);
  });

  it("still marks a seat nobody wired yet as unseated", () => {
    const route = routeGroupMessage({ text: "Tracker, what's my ETA?", senderKind: "owner" });
    expect(route.target).toBe("tracker");
    expect(route.seated).toBe(false);
    expect(unseatedReply("tracker")).toMatch(/isn't in the room yet/);
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
