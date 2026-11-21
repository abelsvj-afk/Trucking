// BT-002: a group reply comes from the ANSWERING bot's account, never the webhook that won the claim.
import { describe, expect, it, vi } from "vitest";
import { buildGroupSenders } from "@/services/bots/group-senders";

const env = { TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN: "scout-token", TELEGRAM_COMPLIANCE_WATCHDOG_BOT_TOKEN: "watchdog-token" };

describe("group senders", () => {
  it("Abel's lines go from Abel's account without the 'Abel:' label (no 'Abel: Abel:'); unlabelled lines stay as they are", async () => {
    const send = vi.fn(async () => [1]);
    const s = buildGroupSenders("abel-token", send, env);
    await s.sendMessage(-100, "Abel: hi");
    await s.sendMessage(-100, "Approved: the shortlist.");
    expect(send.mock.calls).toEqual([["abel-token", -100, "hi"], ["abel-token", -100, "Approved: the shortlist."]]);
  });

  it("Scout's own sender drops his label too (no 'Dispatch Scout:' under his own name)", async () => {
    const send = vi.fn(async () => [1]);
    await buildGroupSenders("abel-token", send, env).scoutSendMessage!(-100, "Dispatch Scout: on it");
    expect(send).toHaveBeenCalledWith("scout-token", -100, "on it");
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

// Owner 2026-11-20: every bot gets its own BotFather account.
describe("every bot on its own account", () => {
  it("'Billing: ...' goes from Billing's own account, without the prefix, once its token is set", async () => {
    const send = vi.fn(async () => [1]);
    await buildGroupSenders("abel-token", send, { TELEGRAM_BILLING_BOT_TOKEN: "billing-token" }).sendMessage(-100, "Billing: invoice ready");
    expect(send).toHaveBeenCalledWith("billing-token", -100, "invoice ready");
  });
  it("before its token is set, it goes from Abel's account with the prefix", async () => {
    const send = vi.fn(async () => [1]);
    await buildGroupSenders("abel-token", send, {}).sendMessage(-100, "Billing: invoice ready");
    expect(send).toHaveBeenCalledWith("abel-token", -100, "Billing: invoice ready");
  });
});
