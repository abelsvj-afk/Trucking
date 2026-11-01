// Driver MVP (docs/design/driver-mvp.md §4). Telegram Bot API webhook
// for the owner's PRIVATE bot. This route is public in src/proxy.ts for
// the same reason /api/internal is: the caller (Telegram's servers) has
// no browser session. It enforces its own checks instead, in order:
// bot token configured (else disabled) -> webhook secret header (if
// configured) -> the gating rules in services/telegram/dispatch-bot.ts
// (private chats only, chat-id allowlist, bootstrap mode before the
// allowlist exists). It never joins or reads any group and never sends
// anything except replies inside the owner's private chat.
//
// Deliberately NOT behind createApiHandler: that pipeline is built for
// session-authenticated owner requests (docs/service-specs.md); this
// caller is authenticated by the webhook secret + allowlist instead.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { suggestDispatchReply } from "@/services/ai/dispatch";
import { runBotChat } from "@/services/ai/bot-chat";
import {
  getTelegramConfig,
  handleTelegramUpdate,
  type TelegramUpdate,
} from "@/services/telegram/dispatch-bot";
import { createTelegramBrainStore, createTelegramStore } from "@/services/telegram/store";
import { runAgentTurn } from "@/services/bot/agent-turn";
import { stageRecordables } from "@/services/bot/stage-recordables";

export const runtime = "nodejs";

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<void> {
  // Telegram caps a message at 4096 characters - split on line breaks.
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > 4000 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const config = getTelegramConfig();

  if (!config.botToken) {
    return NextResponse.json(
      { error: { code: "DISABLED", message: "Telegram bot is not configured." } },
      { status: 503 },
    );
  }

  if (
    config.webhookSecret &&
    !secretMatches(req.headers.get("x-telegram-bot-api-secret-token"), config.webhookSecret)
  ) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid webhook secret." } },
      { status: 401 },
    );
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  const botToken = config.botToken;
  // v2 (§8): the brain store powers the agent loop (tools, proposals,
  // the bot_chat kill switch). It wraps the same service-role client
  // and company scope as the v1 store - both are null together.
  const brainStore = createTelegramBrainStore(config.companyId);
  await handleTelegramUpdate(update, config, {
    sendMessage: (chatId, text) => sendTelegramMessage(botToken, chatId, text),
    // Lazy provider construction: bootstrap/ignored updates must work
    // even if the AI key is missing, and must never pay for a provider
    // they don't use.
    getSuggestion: (message, context) =>
      suggestDispatchReply(new OpenAiProvider(), { message, context }),
    runChat: (input) => runBotChat(new OpenAiProvider(), input),
    runAgent: brainStore
      ? (input) =>
          runAgentTurn(new OpenAiProvider(), brainStore, input, {
            onToolLog: (entry) => console.log("[telegram] bot tool", entry),
          })
      : undefined,
    // §11: recordables extracted from a forwarded/pasted dispatch
    // message are staged as a propose->yes batch on the same brain
    // store - his "yes" resolves them through the agent turn.
    stageRecordables: brainStore
      ? (userText, items) => stageRecordables(brainStore, userText, items)
      : undefined,
    // Null when TELEGRAM_COMPANY_ID / service key aren't configured:
    // the bot then runs reduced (dispatch replies, no context) instead
    // of failing - see services/telegram/store.ts.
    store: createTelegramStore(config.companyId),
  });

  // Always 200 once accepted, so Telegram doesn't retry-storm on a
  // message this bot deliberately ignores (group, wrong chat, ...).
  return NextResponse.json({ ok: true });
}
