import { describe, expect, it, vi } from "vitest";
import { createPersonalitySenders } from "@/services/telegram/personality-send";

const TOKEN = "123456789:AAExampleExampleExampleExampleExample1";
type Call = { method: string; body: Record<string, unknown> };

function fakeTelegram(stickers: { file_id: string; emoji?: string }[] | "fail") {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    if (method === "getStickerSet") {
      return stickers === "fail"
        ? new Response(JSON.stringify({ ok: false, description: "STICKERSET_INVALID" }), { status: 400 })
        : new Response(JSON.stringify({ ok: true, result: { stickers } }));
    }
    return new Response(JSON.stringify({ ok: true, result: true }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("sendSticker", () => {
  it("looks up the emoji in the configured set and sends one matching sticker", async () => {
    const t = fakeTelegram([{ file_id: "PARTY-1", emoji: "🎉" }, { file_id: "LAUGH-1", emoji: "😂" }]);
    const p = createPersonalitySenders(TOKEN, { stickerSet: "MySet", fetchImpl: t.fetchImpl });
    await p.sendSticker(4242, "🎉");
    expect(t.calls[0]).toEqual({ method: "getStickerSet", body: { name: "MySet" } });
    expect(t.calls[1]).toEqual({ method: "sendSticker", body: { chat_id: 4242, sticker: "PARTY-1" } });
  });
  it("uses Telegram's own AnimatedEmojies set by default", async () => {
    const t = fakeTelegram([{ file_id: "X", emoji: "🎉" }]);
    await createPersonalitySenders(TOKEN, { fetchImpl: t.fetchImpl }).sendSticker(1, "🎉");
    expect(t.calls[0]!.body).toEqual({ name: "AnimatedEmojies" });
  });
  it("matches an emoji whatever its variation selector, and picks among several", async () => {
    const t = fakeTelegram([{ file_id: "A", emoji: "❤️" }, { file_id: "B", emoji: "❤" }]);
    const p = createPersonalitySenders(TOKEN, { fetchImpl: t.fetchImpl, random: () => 0.99 });
    await p.sendSticker(1, "❤");
    expect(t.calls[1]!.body.sticker).toBe("B");
  });
  it("caches the set for an hour, then looks again", async () => {
    let clock = 0;
    const t = fakeTelegram([{ file_id: "A", emoji: "🎉" }]);
    const p = createPersonalitySenders(TOKEN, { fetchImpl: t.fetchImpl, now: () => clock });
    await p.sendSticker(1, "🎉");
    await p.sendSticker(1, "🎉");
    expect(t.calls.filter((c) => c.method === "getStickerSet")).toHaveLength(1);
    clock = 61 * 60 * 1000;
    await p.sendSticker(1, "🎉");
    expect(t.calls.filter((c) => c.method === "getStickerSet")).toHaveLength(2);
  });
  it("no matching emoji, a missing set, or a Telegram error sends nothing and throws nothing", async () => {
    const none = fakeTelegram([{ file_id: "A", emoji: "😂" }]);
    await createPersonalitySenders(TOKEN, { fetchImpl: none.fetchImpl }).sendSticker(1, "🎉");
    expect(none.calls.some((c) => c.method === "sendSticker")).toBe(false);
    const bad = fakeTelegram("fail");
    await expect(createPersonalitySenders(TOKEN, { fetchImpl: bad.fetchImpl }).sendSticker(1, "🎉")).resolves.toBeUndefined();
    expect(bad.calls.some((c) => c.method === "sendSticker")).toBe(false);
  });
  it("the bot token never reaches a log line, even when the request throws with the URL in its message", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    const boom = vi.fn(async () => { throw new Error(`fetch failed https://api.telegram.org/bot${TOKEN}/getStickerSet`); }) as unknown as typeof fetch;
    await createPersonalitySenders(TOKEN, { fetchImpl: boom }).sendSticker(1, "🎉");
    await createPersonalitySenders(TOKEN, { fetchImpl: boom }).setReaction(1, 2, "🔥");
    spy.mockRestore();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain("AAExample");
  });
});

describe("setReaction", () => {
  it("reacts to HIS message with the emoji (variation selector removed)", async () => {
    const t = fakeTelegram([]);
    await createPersonalitySenders(TOKEN, { fetchImpl: t.fetchImpl }).setReaction(4242, 55, "❤️");
    expect(t.calls[0]).toEqual({ method: "setMessageReaction", body: { chat_id: 4242, message_id: 55, reaction: [{ type: "emoji", emoji: "❤" }] } });
  });
});

describe("sendGif (Tenor, key-gated)", () => {
  const KEY = "AIzaSyExampleTenorKeyExampleExample123";
  function fakeTenor(results: { media_formats?: Record<string, { url?: string }> }[] | "fail") {
    const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: url.includes("tenor") ? "tenor" : url.split("/").pop()!, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
      if (url.includes("tenor.googleapis.com")) {
        return results === "fail" ? new Response("nope", { status: 403 }) : new Response(JSON.stringify({ results }));
      }
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("searches Tenor with a medium content filter and sends the GIF as an animation", async () => {
    const t = fakeTenor([{ media_formats: { mediumgif: { url: "https://media.tenor.com/abc/party.gif" } } }]);
    await createPersonalitySenders(TOKEN, { tenorKey: KEY, fetchImpl: t.fetchImpl }).sendGif(4242, "celebration dance");
    expect(t.calls[0]!.url).toContain("https://tenor.googleapis.com/v2/search?q=celebration%20dance");
    expect(t.calls[0]!.url).toContain("contentfilter=medium");
    expect(t.calls[0]!.url).toContain(`key=${KEY}`);
    expect(t.calls[1]).toMatchObject({ method: "sendAnimation", body: { chat_id: 4242, animation: "https://media.tenor.com/abc/party.gif" } });
  });
  it("prefers the medium rendition, falls back to gif then tinygif, and ignores non-https results", async () => {
    const t = fakeTenor([{ media_formats: { gif: { url: "http://insecure/x.gif" } } }, { media_formats: { tinygif: { url: "https://media.tenor.com/tiny.gif" } } }]);
    await createPersonalitySenders(TOKEN, { tenorKey: KEY, fetchImpl: t.fetchImpl, random: () => 0 }).sendGif(1, "x y");
    expect(t.calls[1]!.body!.animation).toBe("https://media.tenor.com/tiny.gif");
  });
  it("without a Tenor key the feature is OFF - nothing is requested or sent", async () => {
    const t = fakeTenor([{ media_formats: { gif: { url: "https://x/y.gif" } } }]);
    await createPersonalitySenders(TOKEN, { fetchImpl: t.fetchImpl }).sendGif(1, "party");
    expect(t.calls).toHaveLength(0);
  });
  it("no results or a Tenor error sends nothing and throws nothing", async () => {
    const none = fakeTenor([]);
    await createPersonalitySenders(TOKEN, { tenorKey: KEY, fetchImpl: none.fetchImpl }).sendGif(1, "party");
    expect(none.calls.some((c) => c.method === "sendAnimation")).toBe(false);
    const bad = fakeTenor("fail");
    await expect(createPersonalitySenders(TOKEN, { tenorKey: KEY, fetchImpl: bad.fetchImpl }).sendGif(1, "party")).resolves.toBeUndefined();
    expect(bad.calls.some((c) => c.method === "sendAnimation")).toBe(false);
  });
  it("neither the Tenor key nor the bot token ever reaches a log line, even when the request throws with its URL", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    const boom = vi.fn(async () => { throw new Error(`fetch failed https://tenor.googleapis.com/v2/search?key=${KEY}`); }) as unknown as typeof fetch;
    await createPersonalitySenders(TOKEN, { tenorKey: KEY, fetchImpl: boom }).sendGif(1, "party");
    const forbidden = vi.fn(async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await createPersonalitySenders(TOKEN, { tenorKey: KEY, fetchImpl: forbidden }).sendGif(1, "party");
    spy.mockRestore();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });
});
