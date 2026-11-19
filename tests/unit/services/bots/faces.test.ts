// Bot faces: identity registry for the per-bot Telegram accounts
// (owner rule 2026-11-19 — individual faces, not one face).
import { describe, expect, it } from "vitest";
import { BOT_FACES, faceConfigured, isTeamBotUsername, slugForUsername, teamBotUsernames } from "@/services/bots/faces";

describe("bot faces", () => {
  it("lists one face per bot with a token env var and webhook path, never a token value", () => {
    for (const face of Object.values(BOT_FACES)) {
      expect(face.tokenEnvVar).toMatch(/^TELEGRAM_([A-Z]+_)*BOT_TOKEN$/);
      expect(face.webhookPath).toBe(`/api/telegram/webhook/${face.slug}`);
      expect(face).not.toHaveProperty("token");
    }
  });

  it("trusts only the usernames listed — Abel and Scout today, the rest not yet created", () => {
    expect(isTeamBotUsername("@AbelExecutiveBot")).toBe(true);
    expect(isTeamBotUsername("abelexecutivebot")).toBe(true);
    expect(isTeamBotUsername("@DispatchScoutBot")).toBe(true);
    expect(isTeamBotUsername("StrangerBot")).toBe(false);
    expect(isTeamBotUsername(null)).toBe(false);
    expect(teamBotUsernames()).toEqual(["abelexecutivebot", "dispatchscoutbot"]);
    expect(slugForUsername("AbelExecutiveBot")).toBe("abel");
    expect(slugForUsername("DispatchScoutBot")).toBe("dispatch-scout");
    expect(slugForUsername("TrackerBot")).toBeNull();
  });

  it("marks uncreated faces unconfigured", () => {
    expect(faceConfigured("abel")).toBe(true);
    expect(faceConfigured("dispatch-scout")).toBe(true);
    expect(faceConfigured("tracker")).toBe(false);
  });
});
