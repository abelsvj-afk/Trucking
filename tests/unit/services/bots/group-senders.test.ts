// BT-002: a group reply comes from the ANSWERING bot's account, never the webhook that won the claim.
import { describe, expect, it, vi } from "vitest";
import { buildGroupSenders } from "@/services/bots/group-senders";

const env = { TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN: "scout-token", TELEGRAM_COMPLIANCE_WATCHDOG_BOT_TOKEN: "watchdog-token" };

describe("group senders", () => {
  it("generic replies (Abel, Billing relays, proposal acks) always go from Abel's account", async () => {
    const send = vi.fn(async () => [1]);
    await buildGroupSenders("abel-token", send, env).sendMessage(-100, "Abel: hi");
    expect(send).toHaveBeenCalledWith("abel-token", -100, "Abel: hi");
  });

  it("a bot with its own token sends as itself; one without falls back to Abel's account", async () => {
    const send = vi.fn(async () => [1]);
    const s = buildGroupSenders("abel-token", send, env);
    await s.sendAsBot("compliance-watchdog", -100, "x");
    await s.sendAsBot("billing", -100, "Billing: y");
    expect(send.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["watchdog-token", "abel-token"]);
    expect(await s.sendMessageAs("billing", -100, "z")).toBe(false);
    expect(await s.sendMessageAs("compliance-watchdog", -100, "z")).toBe(true);
    expect(s.scoutSendMessage).toBeDefined();
  });

  it("no Scout token: Scout has no own sender (falls back with his name prefix)", () => {
    expect(buildGroupSenders("abel-token", vi.fn(), {}).scoutSendMessage).toBeUndefined();
  });
});
