// The Telegram Bot API calls the webhook route makes, as one
// testable module: rich (HTML) sends, photo sends, and edits.
// The route itself stays a thin wiring layer.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerTelegramCallbackQuery,
  editTelegramMessageReplyMarkup,
  editTelegramMessageText,
  sendTelegramMessage,
  sendTelegramRichMessage,
  sendTelegramYesNoMessage,
} from "@/services/telegram/bot-api";

const TOKEN = "123456789:AAExample";
const CHAT = 4242;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubFetch(ok = true, result: unknown = { message_id: 77 }, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok, result }), { status });
    }),
  );
  return calls;
}

function jsonBody(call: { init?: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init?.body));
}

describe("sendTelegramRichMessage", () => {
  it("sends an HTML card with parse_mode HTML and the inline keyboard, and returns the message id", async () => {
    const calls = stubFetch();
    const id = await sendTelegramRichMessage(TOKEN, CHAT, {
      kind: "text",
      html: "<b>🚚 Load: Trip 1874</b>\n<b>💵 Pay:</b> $611.20",
      keyboard: [[{ text: "✕ Dismiss", callback_data: "dismiss:load:1874" }]],
    });
    expect(id).toBe(77);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = jsonBody(calls[0]!);
    expect(body.chat_id).toBe(CHAT);
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toContain("<b>🚚 Load: Trip 1874</b>");
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: "✕ Dismiss", callback_data: "dismiss:load:1874" }]],
    });
  });

  it("sends a photo card with the full text as its caption - never a bare image", async () => {
    const calls = stubFetch();
    const id = await sendTelegramRichMessage(TOKEN, CHAT, {
      kind: "photo",
      html: "<b>🚚 Load: Trip 1874</b>",
      photoPng: Buffer.from("fake-png"),
      keyboard: [[{ text: "📱 Open in app", web_app: { url: "https://app.roadtolegacytrucking.com/loads" } }]],
    });
    expect(id).toBe(77);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendPhoto`);
    const body = calls[0]!.init?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("caption")).toBe("<b>🚚 Load: Trip 1874</b>");
    expect((body as FormData).get("parse_mode")).toBe("HTML");
    expect((body as FormData).get("photo")).toBeInstanceOf(Blob);
  });

  it("refuses an over-long HTML message instead of sending a broken one (the caller falls back to plain text)", async () => {
    const calls = stubFetch();
    await expect(
      sendTelegramRichMessage(TOKEN, CHAT, { kind: "text", html: "x".repeat(4097) }),
    ).rejects.toThrow(/too long/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an over-long photo caption instead of silently truncating it", async () => {
    const calls = stubFetch();
    await expect(
      sendTelegramRichMessage(TOKEN, CHAT, {
        kind: "photo",
        html: "x".repeat(1025),
        photoPng: Buffer.from("fake-png"),
      }),
    ).rejects.toThrow(/too long/);
    expect(calls).toHaveLength(0);
  });

  it("a failed send throws so the caller can fall back to plain text", async () => {
    stubFetch(false, null, 400);
    await expect(
      sendTelegramRichMessage(TOKEN, CHAT, { kind: "text", html: "<b>hi</b>" }),
    ).rejects.toThrow("Telegram sendMessage failed.");
  });
});

describe("editTelegramMessageText / editTelegramMessageReplyMarkup", () => {
  it("edits the message text in place with the new HTML + keyboard", async () => {
    const calls = stubFetch();
    const result = await editTelegramMessageText(TOKEN, CHAT, 77, "<b>🚚 Load: Trip 1874</b>\n<b>💵 Pay:</b> $615.00", [
      [{ text: "✕ Dismiss", callback_data: "dismiss:load:1874" }],
    ]);
    expect(result).toBe("edited");
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/editMessageText`);
    const body = jsonBody(calls[0]!);
    expect(body).toMatchObject({ chat_id: CHAT, message_id: 77, parse_mode: "HTML" });
    expect(body.text).toContain("$615.00");
  });

  it("clearing the keyboard edits reply_markup to an empty inline keyboard", async () => {
    const calls = stubFetch();
    const result = await editTelegramMessageReplyMarkup(TOKEN, CHAT, 77, []);
    expect(result).toBe("edited");
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/editMessageReplyMarkup`);
    expect(jsonBody(calls[0]!).reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("'message is not modified' reports unchanged - the caller sends nothing new", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "Bad Request: message is not modified" }), { status: 400 })),
    );
    const result = await editTelegramMessageText(TOKEN, CHAT, 77, "<b>same</b>");
    expect(result).toBe("unchanged");
  });

  it("any other edit failure reports failed - the caller sends fresh instead", async () => {
    stubFetch(false, null, 400);
    expect(await editTelegramMessageText(TOKEN, CHAT, 77, "<b>hi</b>")).toBe("failed");
    expect(await editTelegramMessageReplyMarkup(TOKEN, CHAT, 77, [])).toBe("failed");
  });
});

describe("the plain send path is unchanged", () => {
  it("sendTelegramMessage still sends clean plain text with no parse_mode", async () => {
    const calls = stubFetch();
    await sendTelegramMessage(TOKEN, CHAT, "## Pay this week\n**Load**: Macon → Tampa");
    expect(calls).toHaveLength(1);
    const body = jsonBody(calls[0]!);
    expect(body.parse_mode).toBeUndefined();
    expect(body.text).toContain("💵 Pay this week");
    expect(body.text).not.toContain("*");
  });

  it("sendTelegramYesNoMessage still sends the reply keyboard", async () => {
    const calls = stubFetch();
    await sendTelegramYesNoMessage(TOKEN, CHAT, "Reply YES to confirm");
    const body = jsonBody(calls[0]!);
    expect((body.reply_markup as { keyboard: unknown }).keyboard).toEqual([[{ text: "Yes" }, { text: "No" }]]);
  });

  it("answerTelegramCallbackQuery never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(answerTelegramCallbackQuery(TOKEN, "q-1")).resolves.toBeUndefined();
  });
});
