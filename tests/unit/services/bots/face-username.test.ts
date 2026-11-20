// A bot's username comes from TELEGRAM_<BOT>_BOT_USERNAME when set (no code change per new account).
import { describe, expect, it } from "vitest";
import { botFaceUsername } from "@/services/bots/faces";

describe("botFaceUsername", () => {
  it("reads the env (with or without @), else the table", () => {
    expect(botFaceUsername("billing", { TELEGRAM_BILLING_BOT_USERNAME: "@RoadLegacyBillingBot" })).toBe("RoadLegacyBillingBot");
    expect(botFaceUsername("billing", {})).toBeNull();
    expect(botFaceUsername("dispatch-scout", {})).toBe("DispatchScoutBot");
  });
});
