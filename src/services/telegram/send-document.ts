// Send a FILE to the owner's own Telegram chat (Bot API sendDocument) -
// the roadside "give me this document" path (docs/design/eld-roadside-
// overlay.md): he asks Abel for the inspection packet, the file lands in
// his chat, he shows the officer his screen. Owner chat ONLY, same config
// discipline as notify.ts (TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_CHAT_ID,
// canonical since PR #14/#15). Never throws; a failure is a plain `false`
// and the caller says so out loud - a roadside send must never look sent
// when it wasn't.

const API = "https://api.telegram.org";

export interface TelegramDocument {
  fileName: string;
  contentType: string;
  text: string;
  caption?: string;
}

type FetchFn = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean }>;

export async function sendTelegramDocument(doc: TelegramDocument, deps: { env?: Record<string, string | undefined>; fetchFn?: FetchFn } = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_OWNER_CHAT_ID;
  if (!token || !chatId) return false;
  const doFetch = deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  try {
    const form = new FormData();
    form.set("chat_id", chatId);
    if (doc.caption) form.set("caption", doc.caption.slice(0, 1024));
    form.set("document", new Blob([doc.text], { type: doc.contentType }), doc.fileName);
    const res = await doFetch(`${API}/bot${token}/sendDocument`, { method: "POST", body: form });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}
