// Who a group reply comes FROM (bots & Telegram audit BT-002, 2026-11-20).
//
// Every bot's webhook receives every owner message; the first to claim it does the
// work. The reply's account must follow the bot that is ANSWERING, never the webhook
// that happened to win the claim (before, Scout's webhook winning meant Abel's and
// Billing's replies went out from Scout's account).
//  - generic sends (Abel's voice, "Billing: ..." relays, proposal acks) -> Abel's account;
//  - a bot with its own BotFather token configured -> that bot's own account;
//  - a bot without one -> Abel's account (its name prefix keeps attribution honest).

import { botFaceToken } from "./faces";
import type { BotSlug } from "./registry";

type Send = (token: string, chatId: number, text: string) => Promise<number[]>;

export interface GroupSenders {
  sendMessage: (chatId: number, text: string) => Promise<number[]>;
  sendAsBot: (botSlug: BotSlug, chatId: number, text: string) => Promise<number[]>;
  sendMessageAs: (botSlug: BotSlug, chatId: number, text: string) => Promise<boolean>;
  scoutSendMessage: ((chatId: number, text: string) => Promise<number[]>) | undefined;
}

export function buildGroupSenders(abelToken: string, send: Send, env: Record<string, string | undefined> = process.env): GroupSenders {
  const ownToken = (slug: BotSlug): string | null => (slug === "abel" ? abelToken : botFaceToken(slug, env));
  const scoutToken = ownToken("dispatch-scout");
  return {
    sendMessage: (chatId, text) => send(abelToken, chatId, text),
    sendAsBot: (botSlug, chatId, text) => send(ownToken(botSlug) ?? abelToken, chatId, text),
    sendMessageAs: async (botSlug, chatId, text) => {
      const token = ownToken(botSlug);
      if (!token || botSlug === "abel") return false;
      await send(token, chatId, text);
      return true;
    },
    scoutSendMessage: scoutToken ? (chatId, text) => send(scoutToken, chatId, text) : undefined,
  };
}
