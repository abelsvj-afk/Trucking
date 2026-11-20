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

  it("routes billing terms to Billing, and a broker-plus-paid question to Billing over Scout", () => {
    const overdue = routeGroupMessage({ text: "that invoice is overdue", senderKind: "owner" });
    expect(overdue.target).toBe("billing");
    expect(overdue.seated).toBe(true);
    const factoring = routeGroupMessage({ text: "should we factor this invoice?", senderKind: "owner" });
    expect(factoring.target).toBe("billing");
    const brokerPaid = routeGroupMessage({ text: "has the broker paid yet?", senderKind: "owner" });
    expect(brokerPaid.target).toBe("billing");
    const shortPay = routeGroupMessage({ text: "they short-paid the Detroit load", senderKind: "owner" });
    expect(shortPay.target).toBe("billing");
  });

  it("routes a POD notice to Tracker — POD is more specific than the generic word 'load'", () => {
    const route = routeGroupMessage({ text: "POD signed for the Detroit load", senderKind: "owner" });
    expect(route.target).toBe("tracker");
    expect(route.via).toBe("keyword");
  });

  it("still routes a bare broker question to Dispatch Scout", () => {
    const route = routeGroupMessage({ text: "find me a broker in Dallas", senderKind: "owner" });
    expect(route.target).toBe("dispatch-scout");
  });

  it("names the Auditor for a check, but marks the seat unseated in Phase 0", () => {
    const route = routeGroupMessage({ text: "Auditor, check this math", senderKind: "owner" });
    expect(route.target).toBe("auditor");
    expect(route.seated).toBe(false);
    expect(unseatedReply("auditor")).toMatch(/isn't in the room yet/);
  });

  it("does not route a paycheck question to Billing — bare 'paid' stays with Abel", () => {
    const route = routeGroupMessage({ text: "when do I get paid?", senderKind: "owner" });
    expect(route.target).toBe("abel");
    expect(route.via).toBe("default");
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
