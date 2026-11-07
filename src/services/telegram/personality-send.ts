// Sending stickers and reactions (docs/design/bot-messages-and-safety.md section 7). A sticker is looked up BY EMOJI
// in a public sticker set at run time (getStickerSet) and cached for an hour. Everything here is best-effort: no set,
// no match or any Telegram failure means nothing extra is sent - never an error to him. The bot token never appears
// in a log line (a thrown fetch error's text can carry the request URL).

export const DEFAULT_STICKER_SET = "AnimatedEmojies";
const CACHE_MS = 60 * 60 * 1000;

const plainEmoji = (e: string) => e.replace(/️/g, "");

export function createPersonalitySenders(
  botToken: string,
  options: { stickerSet?: string; fetchImpl?: typeof fetch; now?: () => number; random?: () => number } = {},
) {
  const stickerSet = options.stickerSet || DEFAULT_STICKER_SET;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  let cache: { at: number; byEmoji: Map<string, string[]> } | null = null;

  async function call<T>(method: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T } | null;
      if (!res.ok || !json?.ok) {
        console.error(`[telegram] ${method} failed`, res.status);
        return null;
      }
      return json.result ?? null;
    } catch {
      console.error(`[telegram] ${method} request failed`);
      return null;
    }
  }

  async function fileIdsFor(emoji: string): Promise<string[]> {
    if (!cache || now() - cache.at >= CACHE_MS) {
      const set = await call<{ stickers?: { file_id: string; emoji?: string }[] }>("getStickerSet", { name: stickerSet });
      const byEmoji = new Map<string, string[]>();
      for (const s of set?.stickers ?? []) {
        const key = plainEmoji(s.emoji ?? "");
        if (key) byEmoji.set(key, [...(byEmoji.get(key) ?? []), s.file_id]);
      }
      // A failed lookup is cached too (briefly empty), so a missing set does not hammer Telegram on every reply.
      cache = { at: now(), byEmoji };
    }
    return cache.byEmoji.get(plainEmoji(emoji)) ?? [];
  }

  return {
    async sendSticker(chatId: number, emoji: string): Promise<void> {
      const ids = await fileIdsFor(emoji);
      if (ids.length === 0) return; // nothing for that emoji: the text stands on its own
      await call("sendSticker", { chat_id: chatId, sticker: ids[Math.floor(random() * ids.length)]! });
    },
    async setReaction(chatId: number, messageId: number, emoji: string): Promise<void> {
      await call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji: plainEmoji(emoji) }] });
    },
  };
}
