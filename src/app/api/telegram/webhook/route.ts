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
import { createTelegramBurstCollector } from "@/services/telegram/burst";
import { handleTelegramPhotoIntelligent } from "@/services/telegram/photo-intelligence";
import {
  resolvePhotoPurposeAskById,
  type PhotoPurposeChoice,
} from "@/services/telegram/photo-purpose";
import { runAgentTurn } from "@/services/bot/agent-turn";
import { stageRecordables } from "@/services/bot/stage-recordables";
import { captureForwardThread } from "@/services/bot/thread-capture";
import { createRateLimiter } from "@/services/telegram/rate-limit";
import { createBrainLiveLocationStore, handleLiveLocation } from "@/services/telegram/live-location";
import { applyAutoMotionSwitch } from "@/services/fleet/auto-motion";
import { handleTelegramVoice } from "@/services/telegram/voice-intake";

export const runtime = "nodejs";

/**
 * Telegram repairs (2026-11-03): ONE burst collector for the whole
 * process - forwarded conversations arrive as many separate webhook
 * calls and must land in the same per-chat bundle, so the collector
 * can never be rebuilt per request.
 */
const telegramBurstCollector = createTelegramBurstCollector();

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

/**
 * §3.3: sends a message carrying an inline keyboard (the photo-
 * purpose ask). One message, no chunking - ask texts are short by
 * construction; a failure throws and the bot falls back to the
 * numbered text list.
 */
async function sendTelegramAskMessage(
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

/** §3.3: stops the button-tap spinner. Never throws - a failed ack must not fail the turn. */
async function answerTelegramCallbackQuery(
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

const webhookLimiter = createRateLimiter();

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

  // D-10: bound how fast any one chat can drive the webhook. Dropped updates
  // are acknowledged (200) so Telegram does not redeliver them.
  const chatForLimit =
    update.message?.chat?.id ?? update.edited_message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  const kind = update.edited_message?.location || update.message?.location ? "location" : "message";
  if (!webhookLimiter.allow(String(chatForLimit ?? "unknown"), kind, Date.now())) {
    console.warn("[telegram] rate limit hit - update dropped", { kind });
    return NextResponse.json({ ok: true });
  }

  const botToken = config.botToken;
  // v2 (§8): the brain store powers the agent loop (tools, proposals,
  // the bot_chat kill switch). It wraps the same service-role client
  // and company scope as the v1 store - both are null together.
  const brainStore = createTelegramBrainStore(config.companyId);
  const photoCompanyId = config.companyId;
  await handleTelegramUpdate(update, config, {
    // Live Location: position fixes feed movement detection; proposals
    // (never bookings) go out through the same chat.
    handleLocation: brainStore
      ? async (loc, atMs) => {
          const chatId = Number(config.allowedChatId);
          // The live_location switch: off (or unverifiable) = nothing is stored or proposed.
          if (!(await brainStore.isLiveLocationEnabled())) return;
          await handleLiveLocation(createBrainLiveLocationStore(brainStore), loc, atMs, {
            sendMessage: (text) => sendTelegramMessage(botToken, chatId, text),
            autoSwitch: (detectedAtIso, submissionId) =>
              applyAutoMotionSwitch({
                client: brainStore.client,
                companyId: brainStore.companyId,
                detectedAtIso,
                submissionId,
                nowMs: Date.now(),
                origin: "position feed",
              }),
            formatTime: (t) =>
              new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(t)),
          });
        }
      : undefined,
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
    // Phase C: every dispatch workup also reconstructs the
    // conversation into a stored thread record (best-effort, after
    // the reply - see dispatch-bot). Same brain store scope.
    captureThread: brainStore
      ? (text) => captureForwardThread(brainStore, new OpenAiProvider(), text)
      : undefined,
    // Phase E: voice notes - downloaded + transcribed under the
    // voice_transcription kill switch (brain store reads the same
    // capability rows as every other surface); the transcript then
    // runs the normal text pipeline in dispatch-bot.
    handleVoice: brainStore
      ? (voice) =>
          handleTelegramVoice(voice, {
            botToken,
            isEnabled: () => brainStore.isVoiceTranscriptionEnabled(),
          })
      : undefined,
    // Lane 1 (audit B-1): the dispatch_helper kill switch (global +
    // capability) is checked on this path too, from the same store
    // the web surfaces read - off means no workup on Telegram either.
    isDispatchHelperEnabled: brainStore
      ? () => brainStore.isDispatchHelperEnabled()
      : undefined,
    // §13: photo messages store through the shared documents
    // pipeline on the same service-role client + company scope.
    // Absent in reduced mode - the bot then says so honestly.
    // Image Intelligence (§3): the intelligent front door runs the
    // show - with its capability off it delegates to the §13 intake
    // untouched, so wiring it here changes nothing until the owner
    // turns Photo understanding on.
    handlePhoto:
      brainStore && photoCompanyId
        ? (photo, caption, mediaGroupId) =>
            handleTelegramPhotoIntelligent(
              { client: brainStore.client, companyId: photoCompanyId, botToken, brainStore },
              photo,
              caption,
              mediaGroupId,
            )
        : undefined,
    // §3.3: inline-keyboard asks + their tap resolution.
    sendAskMessage: (chatId, text, buttons) =>
      sendTelegramAskMessage(botToken, chatId, text, buttons),
    answerCallbackQuery: (queryId, text) =>
      answerTelegramCallbackQuery(botToken, queryId, text),
    resolvePhotoAsk:
      brainStore && photoCompanyId
        ? (pendingId, choice) =>
            resolvePhotoPurposeAskById(
              { client: brainStore.client, companyId: photoCompanyId, brainStore },
              pendingId,
              choice as PhotoPurposeChoice,
            )
        : undefined,
    isPhotoIntelligenceEnabled: brainStore
      ? () => brainStore.isPhotoIntelligenceEnabled()
      : undefined,
    // Null when TELEGRAM_COMPANY_ID / service key aren't configured:
    // the bot then runs reduced (dispatch replies, no context) instead
    // of failing - see services/telegram/store.ts.
    store: createTelegramStore(config.companyId),
    burstCollector: telegramBurstCollector,
  });

  // Always 200 once accepted, so Telegram doesn't retry-storm on a
  // message this bot deliberately ignores (group, wrong chat, ...).
  return NextResponse.json({ ok: true });
}
