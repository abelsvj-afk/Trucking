// Per-bot Telegram sending: individual faces (owner decision
// 2026-11-19) — a bot posts from its own token when configured,
// and falls back to the shared token with a text label until then.
import { describe, expect, it } from "vitest";
import {
  botTokenEnvName,
  botUsernameEnvName,
  botUsernameFor,
  labelBotMessage,
  resolveBotSender,
  slugForBotUsername,
} from "@/services/bots/sending";

describe("per-bot sending — individual faces", () => {
  it("names the env var per bot slug", () => {
    expect(botTokenEnvName("maintenance")).toBe("TELEGRAM_MAINTENANCE_BOT_TOKEN");
    expect(botTokenEnvName("dispatch-scout")).toBe("TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN");
    expect(botTokenEnvName("abel")).toBe("TELEGRAM_ABEL_BOT_TOKEN");
  });

  it("sends as itself when its own token is configured", () => {
    const sender = resolveBotSender("maintenance", "shared-token", { TELEGRAM_MAINTENANCE_BOT_TOKEN: "maint-token" });
    expect(sender).toEqual({ token: "maint-token", asSelf: true });
  });

  it("falls back to the shared token when its own token is missing or blank", () => {
    expect(resolveBotSender("maintenance", "shared-token", {})).toEqual({ token: "shared-token", asSelf: false });
    expect(resolveBotSender("maintenance", "shared-token", { TELEGRAM_MAINTENANCE_BOT_TOKEN: "   " })).toEqual({
      token: "shared-token",
      asSelf: false,
    });
  });

  it("labels the message only on the shared-token fallback", () => {
    expect(labelBotMessage("Maintenance", "Oil change is due.", true)).toBe("Oil change is due.");
    expect(labelBotMessage("Maintenance", "Oil change is due.", false)).toBe("Maintenance: Oil change is due.");
  });

  it("names the username env var per bot slug", () => {
    expect(botUsernameEnvName("maintenance")).toBe("TELEGRAM_MAINTENANCE_BOT_USERNAME");
    expect(botUsernameEnvName("dispatch-scout")).toBe("TELEGRAM_DISPATCH_SCOUT_BOT_USERNAME");
  });

  it("reads a bot's configured username, null when not provisioned", () => {
    expect(botUsernameFor("maintenance", { TELEGRAM_MAINTENANCE_BOT_USERNAME: "MaintenanceBot" })).toBe("MaintenanceBot");
    expect(botUsernameFor("maintenance", { TELEGRAM_MAINTENANCE_BOT_USERNAME: "@MaintenanceBot" })).toBe("MaintenanceBot");
    expect(botUsernameFor("maintenance", {})).toBeNull();
    expect(botUsernameFor("maintenance", { TELEGRAM_MAINTENANCE_BOT_USERNAME: "   " })).toBeNull();
  });

  it("maps a Telegram username back to its bot slug, case-insensitive, @ optional", () => {
    const env = {
      TELEGRAM_MAINTENANCE_BOT_USERNAME: "MaintenanceBot",
      TELEGRAM_DISPATCH_SCOUT_BOT_USERNAME: "DispatchScoutBot",
    };
    expect(slugForBotUsername("MaintenanceBot", env)).toBe("maintenance");
    expect(slugForBotUsername("@maintenancebot", env)).toBe("maintenance");
    expect(slugForBotUsername("DispatchScoutBot", env)).toBe("dispatch-scout");
    expect(slugForBotUsername("StrangerBot", env)).toBeNull();
    expect(slugForBotUsername(null, env)).toBeNull();
    expect(slugForBotUsername("MaintenanceBot", {})).toBeNull();
  });
});
