// POST /api/telegram/webhook: per-face routing (bots & Telegram audit BT-001, BT-004).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const sent = vi.hoisted(() => [] as { token: string; chatId: number; text: string }[]);
const handleTelegramUpdate = vi.hoisted(() => vi.fn(async () => undefined));
const handleGroup = vi.hoisted(() => vi.fn(async () => "handled"));

vi.mock("@/services/telegram/bot-api", async (orig) => ({
  ...(await orig<object>()),
  sendTelegramMessage: vi.fn(async (token: string, chatId: number, text: string) => {
    sent.push({ token, chatId, text });
    return [1];
  }),
}));
vi.mock("@/services/telegram/dispatch-bot", async (orig) => ({
  ...(await orig<object>()),
  getTelegramConfig: () => ({ botToken: "abel-token", webhookSecret: "s3cret", allowedChatId: "100000001", groupChatId: "-1001", companyId: "c1" }),
  handleTelegramUpdate,
}));
vi.mock("@/services/bots/group", async (orig) => ({ ...(await orig<object>()), handleBotTeamGroupUpdate: handleGroup }));
vi.mock("@/services/bots/store", async (orig) => ({ ...(await orig<object>()), createBotTeamStore: () => null }));
vi.mock("@/services/telegram/store", async (orig) => ({ ...(await orig<object>()), createTelegramBrainStore: () => null, createTelegramStore: () => null }));

import { POST } from "@/app/api/telegram/webhook/route";

const original = { ...process.env };
beforeEach(() => {
  process.env.TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN = "scout-token";
  sent.length = 0;
  handleTelegramUpdate.mockClear();
  handleGroup.mockClear();
});
afterEach(() => {
  process.env = { ...original };
});

let updateId = 1;
function post(bot: string | null, chat: { id: number; type: string }, text = "hello") {
  const url = `http://x/api/telegram/webhook${bot ? `?bot=${bot}` : ""}`;
  const body = { update_id: updateId++, message: { message_id: updateId, from: { id: 100000001, is_bot: false }, chat, text } };
  return POST(new NextRequest(url, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "s3cret" }, body: JSON.stringify(body) }));
}

describe("telegram webhook per-face routing", () => {
  it("BT-001: a private message to Scout runs no Abel turn; Scout answers from his own account, by name", async () => {
    const res = await post("dispatch-scout", { id: 100000001, type: "private" });
    expect(res.status).toBe(200);
    expect(handleTelegramUpdate).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.token).toBe("scout-token");
    expect(sent[0]!.text).toContain("Dispatch Scout");
  });

  it("a private message on Abel's webhook still reaches Abel", async () => {
    await post(null, { id: 100000001, type: "private" });
    expect(handleTelegramUpdate).toHaveBeenCalledTimes(1);
  });

  it("BT-004: Scout's copies of group messages never use up the limit", async () => {
    // 80 copies on Scout's webhook (over the 60/minute allowance), then Abel's copy still gets through.
    for (let i = 0; i < 80; i++) await post("dispatch-scout", { id: -1001, type: "supergroup" });
    const before = handleGroup.mock.calls.length;
    await post(null, { id: -1001, type: "supergroup" });
    expect(handleGroup.mock.calls.length).toBe(before + 1);
    expect(sent.some((m) => m.text.includes("dropped"))).toBe(false);
  });
});
