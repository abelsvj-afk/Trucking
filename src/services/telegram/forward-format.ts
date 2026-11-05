// Forwarded-message labeling and bundling for the Telegram bot (Telegram repairs,
// 2026-11-03). Pure. Split out of dispatch-bot.ts (decomposition pass, behavior
// unchanged); dispatch-bot re-exports both names so existing imports keep working.

import type { TelegramBurstItem } from "./burst";
import type { TelegramUpdate } from "./dispatch-bot";

/**
 * Who a forward came from, from Telegram's structured metadata
 * (forward_origin variants + the legacy forward_from). Display
 * and context labeling only - never an identity assertion.
 */
export function forwardSourceLabel(
  message: TelegramUpdate["message"] | undefined,
): string | null {
  if (!message) return null;
  const origin = message.forward_origin as Record<string, unknown> | null | undefined;
  if (origin && typeof origin === "object") {
    const userName = (user: unknown): string | null => {
      if (!user || typeof user !== "object") return null;
      const u = user as Record<string, unknown>;
      const parts = [u.first_name, u.last_name].filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      if (parts.length > 0) return parts.join(" ");
      return typeof u.username === "string" ? `@${u.username}` : null;
    };
    const chatTitle = (chat: unknown): string | null => {
      if (!chat || typeof chat !== "object") return null;
      const c = chat as Record<string, unknown>;
      return typeof c.title === "string" ? c.title : null;
    };
    const signature =
      typeof origin.author_signature === "string" ? origin.author_signature : null;
    const label =
      userName(origin.sender_user) ??
      (typeof origin.sender_user_name === "string" ? origin.sender_user_name : null) ??
      chatTitle(origin.sender_chat) ??
      chatTitle(origin.chat);
    if (label) return signature && signature !== label ? `${label} (${signature})` : label;
    if (signature) return signature;
  }
  const from = message.forward_from as Record<string, unknown> | null | undefined;
  if (from && typeof from === "object") {
    const parts = [from.first_name, from.last_name].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    if (parts.length > 0) return parts.join(" ");
    if (typeof from.username === "string") return `@${from.username}`;
  }
  return null;
}

/** The bundle as one dispatch input: every forwarded message, numbered, source-labeled where Telegram names one. */
export function formatForwardBundle(items: TelegramBurstItem[]): string {
  return items
    .map(
      (item, i) =>
        `[Forwarded message ${i + 1} of ${items.length}${item.sourceLabel ? ` — from ${item.sourceLabel}` : ""}]\n${item.text}`,
    )
    .join("\n\n");
}
