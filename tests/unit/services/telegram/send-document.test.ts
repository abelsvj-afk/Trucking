// sendDocument helper: owner chat only, multipart file, honest false on
// any failure (missing config, Telegram refusal, network error) - a
// roadside send must never look sent when it wasn't.

import { describe, expect, it, vi } from "vitest";
import { sendTelegramDocument } from "@/services/telegram/send-document";

const ENV = { TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_OWNER_CHAT_ID: "4242" };
const DOC = { fileName: "inspection-packet.txt", contentType: "text/plain", text: "PACKET TEXT", caption: "cap" };

describe("sendTelegramDocument", () => {
  it("posts the file to the owner's chat via sendDocument", async () => {
    const calls: { url: string; init: Record<string, unknown> }[] = [];
    const ok = await sendTelegramDocument(DOC, {
      env: ENV,
      fetchFn: async (url, init) => { calls.push({ url, init }); return { ok: true }; },
    });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bottok/sendDocument");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("chat_id")).toBe("4242");
    const file = form.get("document") as File;
    expect(file.name).toBe("inspection-packet.txt");
    expect(await file.text()).toBe("PACKET TEXT");
  });

  it("returns false without config, on refusal, and on a network throw", async () => {
    expect(await sendTelegramDocument(DOC, { env: {}, fetchFn: async () => ({ ok: true }) })).toBe(false);
    expect(await sendTelegramDocument(DOC, { env: ENV, fetchFn: async () => ({ ok: false }) })).toBe(false);
    expect(await sendTelegramDocument(DOC, { env: ENV, fetchFn: vi.fn(async () => { throw new Error("down"); }) })).toBe(false);
  });
});
