// The bot-to-bot channel: identification by Telegram username, the
// pickup verdict (addressed + seated + under the chain cap, never
// self), and the chain-depth count. The Telegram mechanics these
// encode are cited in bots/bot-channel.ts (Bot Features doc,
// "Bot-to-Bot Communication", verified 2026-11-19).
import { describe, expect, it } from "vitest";
import { botChainDepth, evaluateBotPickup, identifyTeamBot, MAX_BOT_CHAIN_DEPTH } from "@/services/bots/bot-channel";
import { routeGroupMessage } from "@/services/bots/router";

describe("identifyTeamBot", () => {
  it("knows Scout by his BotFather username, case-insensitively, @ or not", () => {
    expect(identifyTeamBot("DispatchScoutBot")).toBe("dispatch-scout");
    expect(identifyTeamBot("@dispatchscoutbot")).toBe("dispatch-scout");
  });

  it("an unlisted bot is not in the room", () => {
    expect(identifyTeamBot("SomeRandomBot")).toBeNull();
    expect(identifyTeamBot(null)).toBeNull();
    expect(identifyTeamBot(undefined)).toBeNull();
    expect(identifyTeamBot("")).toBeNull();
  });
});

describe("evaluateBotPickup", () => {
  const routeToWatchdog = routeGroupMessage({
    text: "Watchdog, is the medical card current?",
    senderKind: "bot",
    senderSlug: "dispatch-scout",
  });

  it("an addressed message to a seated bot is picked up", () => {
    expect(routeToWatchdog.target).toBe("compliance-watchdog");
    const verdict = evaluateBotPickup({ senderSlug: "dispatch-scout", route: routeToWatchdog, chainDepth: 0 });
    expect(verdict.pickup).toBe(true);
  });

  it("a bot never answers itself", () => {
    const ownWords = routeGroupMessage({
      text: "medical card deadline check",
      senderKind: "bot",
      senderSlug: "compliance-watchdog",
    });
    expect(ownWords.target).toBe("compliance-watchdog");
    const verdict = evaluateBotPickup({ senderSlug: "compliance-watchdog", route: ownWords, chainDepth: 0 });
    expect(verdict.pickup).toBe(false);
    expect(verdict.reason).toContain("never answers its own");
  });

  it("unaddressed bot chatter wakes nobody (default route, bot sender)", () => {
    const chatter = routeGroupMessage({ text: "nice weather for a run", senderKind: "bot", senderSlug: "dispatch-scout" });
    expect(chatter.target).toBe("abel");
    expect(chatter.shouldAnswer).toBe(false);
    const verdict = evaluateBotPickup({ senderSlug: "dispatch-scout", route: chatter, chainDepth: 0 });
    expect(verdict.pickup).toBe(false);
  });

  it("at the chain cap, bots stop answering bots until a human speaks", () => {
    const verdict = evaluateBotPickup({
      senderSlug: "dispatch-scout",
      route: routeToWatchdog,
      chainDepth: MAX_BOT_CHAIN_DEPTH,
    });
    expect(verdict.pickup).toBe(false);
    expect(verdict.reason).toContain("chain depth");
  });

  it("a message for an unseated seat is heard, not answered", () => {
    const forMaintenance = routeGroupMessage({ text: "Maintenance, where is the truck?", senderKind: "bot", senderSlug: "dispatch-scout" });
    const verdict = evaluateBotPickup({ senderSlug: "dispatch-scout", route: forMaintenance, chainDepth: 0 });
    expect(verdict.pickup).toBe(false);
  });
});

describe("botChainDepth", () => {
  it("counts consecutive bot messages at the head of the log", () => {
    expect(botChainDepth([{ sender_kind: "bot" }, { sender_kind: "bot" }, { sender_kind: "owner" }, { sender_kind: "bot" }])).toBe(2);
  });

  it("a human message at the head resets the chain to zero", () => {
    expect(botChainDepth([{ sender_kind: "owner" }, { sender_kind: "bot" }])).toBe(0);
    expect(botChainDepth([])).toBe(0);
  });
});
