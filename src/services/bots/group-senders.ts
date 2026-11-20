// Who a group reply comes FROM (bots & Telegram audit BT-002, 2026-11-20).
//
// Every bot's webhook receives every owner message; the first to claim it does the
// work. The reply's account must follow the bot that is ANSWERING, never the webhook
// that happened to win the claim (before, Scout's webhook winning meant Abel's and
// Billing's replies went out from Scout's account).
//  - owner 2026-11-20: EVERY bot gets its own BotFather account. A message that speaks as a
//    bot ("Billing: ...") goes from THAT bot's account, without the name prefix (its own
//    name and photo say who is talking);
//  - until a bot's token is set, it goes from Abel's account WITH the prefix;
//  - unprefixed system lines and proposal acks -> Abel's account (the coordinator).

import { botFaceToken, parseRoomSpeaker } from "./faces";
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
    sendMessage: (chatId, text) => {
      const speaker = parseRoomSpeaker(text);
      const token = speaker && speaker !== "abel" ? ownToken(speaker) : null;
      return token ? send(token, chatId, text.replace(/^\s*[A-Za-z ]+:\s*/, "")) : send(abelToken, chatId, text);
    },
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
