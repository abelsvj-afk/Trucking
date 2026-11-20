// Auditor group routing (owner, 2026-11-19 — team-room correction
// of the earlier too-strict rule): the group chat is a team room.
// Bots hand work off to each other; Abel is the boss for what needs
// the owner's attention, not the only one who talks. Reconciled for
// the Auditor: it answers when called by name, when routed to it by
// Abel or handed off by any other bot, and on its own turn (a draft
// has landed and needs checking). A message that merely looks like
// its job — keyword, no name, no handoff, nothing checkable — does
// NOT wake it: it stays quiet and Abel settles it in the room. In
// its own 1:1 chat (direct) it handles its own job directly.
import { describe, expect, it } from "vitest";
import { routeGroupMessage } from "@/services/bots/router";

describe("auditor group routing", () => {
  it("answers when called by name", () => {
    const route = routeGroupMessage({ text: "Auditor, check this math", senderKind: "owner" });
    expect(route.target).toBe("auditor");
    expect(route.via).toBe("mention");
    expect(route.shouldAnswer).toBe(true);
    expect(route.seated).toBe(true);
  });

  it("answers a reply to its own message — its own turn", () => {
    const route = routeGroupMessage({ text: "yes, that one", senderKind: "owner", replyToBotSlug: "auditor" });
    expect(route.target).toBe("auditor");
    expect(route.via).toBe("reply");
    expect(route.shouldAnswer).toBe(true);
  });

  it("answers when Abel, the coordinator, routes the job to it", () => {
    const route = routeGroupMessage({
      text: "check the math on this load",
      senderKind: "owner",
      routedByBotSlug: "abel",
    });
    expect(route.target).toBe("auditor");
    expect(route.via).toBe("abel-route");
    expect(route.shouldAnswer).toBe(true);
  });

  it("answers a handoff from any other bot, not just Abel — the team room hands work off", () => {
    const route = routeGroupMessage({
      text: "check the math on this load",
      senderKind: "owner",
      routedByBotSlug: "dispatch-scout",
    });
    expect(route.target).toBe("auditor");
    expect(route.via).toBe("bot-handoff");
    expect(route.shouldAnswer).toBe(true);
  });

  it("answers on its own turn when a draft has landed — keyword plus checkable numbers", () => {
    const route = routeGroupMessage({
      text: "does that add up? pay $1,400, $3.00/mi, 500 miles",
      senderKind: "owner",
    });
    expect(route.target).toBe("auditor");
    expect(route.via).toBe("own-turn");
    expect(route.shouldAnswer).toBe(true);
    expect(route.deferredToCoordinator).toBeUndefined();
  });

  it("answers on its own turn for 'verify the pay' when the figures are in the message", () => {
    const route = routeGroupMessage({
      text: "verify the pay: $1,500, 500 loaded miles",
      senderKind: "owner",
    });
    expect(route.target).toBe("auditor");
    expect(route.via).toBe("own-turn");
    expect(route.shouldAnswer).toBe(true);
  });

  it("answers when Abel routes it by name", () => {
    const route = routeGroupMessage({
      text: "Auditor, look at this draft",
      senderKind: "owner",
      routedByBotSlug: "abel",
    });
    expect(route.target).toBe("auditor");
    expect(route.via).toBe("abel-route");
    expect(route.shouldAnswer).toBe(true);
  });

  it("stays quiet on a keyword alone — 'does that add up' defers to Abel", () => {
    const route = routeGroupMessage({ text: "does that add up?", senderKind: "owner" });
    expect(route.target).toBe("auditor");
    expect(route.via).toBe("keyword");
    expect(route.shouldAnswer).toBe(false);
    expect(route.deferredToCoordinator).toBe("abel");
  });

  it("stays quiet on 'verify' and 'check this' with no name — both defer to Abel", () => {
    for (const text of ["verify the pay on this one", "check this for me", "the math looks wrong"]) {
      const route = routeGroupMessage({ text, senderKind: "owner" });
      expect(route.target).toBe("auditor");
      expect(route.shouldAnswer).toBe(false);
      expect(route.deferredToCoordinator).toBe("abel");
    }
  });

  it("does not steal another bot's job: load talk still goes to Dispatch Scout", () => {
    const route = routeGroupMessage({ text: "find me a load to Dallas", senderKind: "owner" });
    expect(route.target).toBe("dispatch-scout");
    expect(route.shouldAnswer).toBe(true);
  });

  it("does not answer a plain message that belongs to Abel", () => {
    const route = routeGroupMessage({ text: "hey, how is my week looking?", senderKind: "owner" });
    expect(route.target).toBe("abel");
    expect(route.shouldAnswer).toBe(true);
  });

  it("in its own 1:1 chat (direct) a job keyword answers — no deferral there", () => {
    const route = routeGroupMessage({ text: "does that add up?", senderKind: "owner", channel: "direct" });
    expect(route.target).toBe("auditor");
    expect(route.via).toBe("keyword");
    expect(route.shouldAnswer).toBe(true);
    expect(route.deferredToCoordinator).toBeUndefined();
  });

  it("in its own 1:1 chat 'verify the pay' answers directly", () => {
    const route = routeGroupMessage({ text: "verify the pay on this one", senderKind: "owner", channel: "direct" });
    expect(route.target).toBe("auditor");
    expect(route.shouldAnswer).toBe(true);
  });
});
