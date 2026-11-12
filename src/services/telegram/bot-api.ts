// The Telegram Bot API calls the webhook route makes, as one
// testable module. The plain-text sender is the route's original
// (formatReply backstop, 4096-char chunking); the rich sender,
// photo sender and editors are the rich-cards addition (owner
// 2026-11-11). Presentation only - no words, decisions or rules
// live here.

import { formatReply, splitTelegramMessage } from "./format-reply";
import type { InlineKeyboard } from "./cards";
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_LIMIT } from "./cards";

/** What the rich send path carries: an HTML text card, or a photo card whose caption IS the full card text. */
export type RichTelegramMessage =
  | { kind: "text"; html: string; keyboard?: InlineKeyboard }
  | { kind: "photo"; html: string; photoPng: Buffer; keyboard?: InlineKeyboard };

/** Edit outcome: "edited" | "unchanged" (same content - send nothing new) | "failed" (send fresh instead). */
export type EditMessageResult = "edited" | "unchanged" | "failed";

async function postTelegram(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: { message_id?: number }; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: { ok: boolean; result?: { message_id?: number }; description?: string } = { ok: res.ok };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    // Telegram always answers JSON; a non-JSON answer is a failure either way.
  }
  return { ...parsed, ok: res.ok && parsed.ok !== false };
}

export async function sendTelegramMessage(botToken: string, chatId: number, rawText: string): Promise<void> {
  // Backstop: whatever reaches Telegram is clean plain text (idempotent - already-formatted text is unchanged).
  const text = formatReply(rawText);
  // Telegram caps a message at 4096 characters - split on line breaks, and
  // hard-split any single line that is over the limit on its own (T-006).
  const chunks = splitTelegramMessage(text);

  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      // Server log only - never surface provider detail to any client.
      console.error("[telegram] sendMessage failed", res.status);
      throw new Error("Telegram sendMessage failed.");
    }
  }
}

/**
 * §3.3: sends a message carrying an inline keyboard (the photo-
 * purpose ask). One message, no chunking - ask texts are short by
 * construction; a failure throws and the bot falls back to the
 * numbered text list.
 */
export async function sendTelegramAskMessage(
  botToken: string,
  chatId: number,
  text: string,
  buttons: { text: string; callback_data: string }[][],
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) {
    console.error("[telegram] sendMessage (ask) failed", res.status);
    throw new Error("Telegram sendMessage failed.");
  }
}

/**
 * A Yes / No reply keyboard under a proposal. Pressing a key sends the plain message "Yes" / "No" through the
 * normal text path (no callback_query needed), and one_time_keyboard hides it again after use.
 */
export async function sendTelegramYesNoMessage(botToken: string, chatId: number, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        keyboard: [[{ text: "Yes" }, { text: "No" }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }),
  });
  if (!res.ok) {
    console.error("[telegram] sendMessage (yes/no keyboard) failed", res.status);
    throw new Error("Telegram sendMessage failed.");
  }
}

/** §3.3: stops the button-tap spinner. Never throws - a failed ack must not fail the turn. */
export async function answerTelegramCallbackQuery(
  botToken: string,
  queryId: string,
  text?: string,
): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: queryId, ...(text ? { text } : {}) }),
    });
    if (!res.ok) console.error("[telegram] answerCallbackQuery failed", res.status);
  } catch (err) {
    console.error("[telegram] answerCallbackQuery failed", err);
  }
}

/**
 * Sends one rich card and returns its Telegram message id (the
 * edit-in-place registry's key). Throws when the card cannot be
 * sent at all - the caller falls back to plain text. Refuses an
 * over-long message / caption instead of sending a truncated one.
 */
export async function sendTelegramRichMessage(
  botToken: string,
  chatId: number,
  msg: RichTelegramMessage,
): Promise<number> {
  if (msg.kind === "text") {
    if (msg.html.length > TELEGRAM_MESSAGE_LIMIT) {
      throw new Error(`Telegram rich message too long (${msg.html.length} > ${TELEGRAM_MESSAGE_LIMIT}).`);
    }
    const sent = await postTelegram(botToken, "sendMessage", {
      chat_id: chatId,
      text: msg.html,
      parse_mode: "HTML",
      ...(msg.keyboard ? { reply_markup: { inline_keyboard: msg.keyboard } } : {}),
    });
    if (!sent.ok || typeof sent.result?.message_id !== "number") {
      console.error("[telegram] sendMessage (rich) failed");
      throw new Error("Telegram sendMessage failed.");
    }
    return sent.result.message_id;
  }
  if (msg.html.length > TELEGRAM_CAPTION_LIMIT) {
    throw new Error(`Telegram photo caption too long (${msg.html.length} > ${TELEGRAM_CAPTION_LIMIT}).`);
  }
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([Uint8Array.from(msg.photoPng)], { type: "image/png" }), "card.png");
  form.append("caption", msg.html);
  form.append("parse_mode", "HTML");
  if (msg.keyboard) form.append("reply_markup", JSON.stringify({ inline_keyboard: msg.keyboard }));
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  let parsed: { ok: boolean; result?: { message_id?: number } } = { ok: res.ok };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    // Non-JSON answer is a failure either way.
  }
  if (!res.ok || !parsed.ok || typeof parsed.result?.message_id !== "number") {
    console.error("[telegram] sendPhoto (card) failed", res.status);
    throw new Error("Telegram sendPhoto failed.");
  }
  return parsed.result.message_id;
}

/**
 * Edits a sent card's text in place (same message, new state).
 * Never throws: "unchanged" means the card already shows this
 * content (send nothing new); "failed" means send fresh instead.
 */
export async function editTelegramMessageText(
  botToken: string,
  chatId: number,
  messageId: number,
  html: string,
  keyboard?: InlineKeyboard,
): Promise<EditMessageResult> {
  try {
    const sent = await postTelegram(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
    if (sent.ok) return "edited";
    if (typeof sent.description === "string" && sent.description.includes("message is not modified")) {
      return "unchanged";
    }
    console.error("[telegram] editMessageText failed", sent.description ?? "");
    return "failed";
  } catch (err) {
    console.error("[telegram] editMessageText failed", err instanceof Error ? err.message : err);
    return "failed";
  }
}

/**
 * Edits only a message's inline keyboard - the Dismiss tap and the
 * proposal-resolution cleanup. An empty keyboard removes the
 * buttons. Never throws; same outcome contract as editMessageText.
 */
export async function editTelegramMessageReplyMarkup(
  botToken: string,
  chatId: number,
  messageId: number,
  keyboard: InlineKeyboard,
): Promise<EditMessageResult> {
  try {
    const sent = await postTelegram(botToken, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: keyboard },
    });
    if (sent.ok) return "edited";
    if (typeof sent.description === "string" && sent.description.includes("message is not modified")) {
      return "unchanged";
    }
    console.error("[telegram] editMessageReplyMarkup failed", sent.description ?? "");
    return "failed";
  } catch (err) {
    console.error("[telegram] editMessageReplyMarkup failed", err instanceof Error ? err.message : err);
    return "failed";
  }
}
