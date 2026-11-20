// Per-bot Telegram faces: identity shape, setup checklist, speaker
// attribution, and the live BotFather settings check (getMe).
// No username is invented here — a face with no account yet reports
// exactly that.
import { describe, expect, it, vi } from "vitest";
import {
  botFaceSetupChecklist,
  botFaceToken,
  fetchBotFaceStatus,
  parseRoomSpeaker,
  resolveBotFace,
} from "@/services/bots/faces";

describe("bot faces", () => {
  it("Billing's face is not wired without a token, an account, or a photo", () => {
    const status = resolveBotFace("billing", {});
    expect(status.tokenPresent).toBe(false);
    expect(status.tokenEnvVar).toBe("TELEGRAM_BILLING_BOT_TOKEN");
    expect(status.username).toBeNull();
    expect(status.missing).toContain("Fly secret TELEGRAM_BILLING_BOT_TOKEN is not set");
    expect(status.missing).toContain("Telegram account not created yet in @BotFather (no username)");
    expect(status.missing).toContain("Profile photo not set yet (owner sets it)");
  });

  it("a set token leaves only the account and the photo missing", () => {
    const status = resolveBotFace("billing", { TELEGRAM_BILLING_BOT_TOKEN: "123:abc" });
    expect(status.tokenPresent).toBe(true);
    expect(botFaceToken("billing", { TELEGRAM_BILLING_BOT_TOKEN: "123:abc" })).toBe("123:abc");
    expect(status.missing).toHaveLength(2);
  });

  it("Scout's face is known: @DispatchScoutBot, token env TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN", () => {
    const status = resolveBotFace("dispatch-scout", { TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN: "123:abc" });
    expect(status.username).toBe("DispatchScoutBot");
    expect(status.tokenPresent).toBe(true);
  });

  it("the setup checklist names the exact BotFather settings and the per-bot webhook", () => {
    const steps = botFaceSetupChecklist("billing");
    expect(steps.join("\n")).toContain("Bot-to-Bot Communication Mode");
    expect(steps.join("\n")).toContain("Group Privacy");
    expect(steps.join("\n")).toContain("Remove and re-add the bot to the group");
    expect(steps.join("\n")).toContain("/api/telegram/webhook?bot=billing");
    expect(steps.join("\n")).toContain("TELEGRAM_BILLING_BOT_TOKEN");
    expect(steps.join("\n")).not.toContain("TELEGRAM_BOT_TOKEN ");
  });

  it("parseRoomSpeaker attributes prefixed room speech, nothing else", () => {
    expect(parseRoomSpeaker("Billing: invoice ready")).toBe("billing");
    expect(parseRoomSpeaker("Abel: noted")).toBe("abel");
    expect(parseRoomSpeaker("Dispatch Scout: scanning")).toBe("dispatch-scout");
    expect(parseRoomSpeaker("Tracker: POD signed")).toBe("tracker");
    expect(parseRoomSpeaker("hello everyone")).toBeNull();
    expect(parseRoomSpeaker("Billing, invoice the load")).toBeNull();
  });

  it("fetchBotFaceStatus reports privacy-off from getMe", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: { username: "RoadToLegacyBillingBot", can_join_groups: true, can_read_all_group_messages: true },
      }),
    }));
    const status = await fetchBotFaceStatus("token", fetchImpl as unknown as typeof fetch);
    expect(status.canReadAllGroupMessages).toBe(true);
    expect(status.username).toBe("RoadToLegacyBillingBot");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.telegram.org/bottoken/getMe");
  });

  it("fetchBotFaceStatus reports privacy-on and throws on a failed getMe", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { username: "X", can_join_groups: true, can_read_all_group_messages: false } }),
    }));
    expect((await fetchBotFaceStatus("token", fetchImpl as unknown as typeof fetch)).canReadAllGroupMessages).toBe(false);
    const failing = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(fetchBotFaceStatus("bad", failing as unknown as typeof fetch)).rejects.toThrow("getMe failed");
  });
});
