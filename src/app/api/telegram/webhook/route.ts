// Driver MVP (docs/design/driver-mvp.md §4). Telegram Bot API webhook
// for the owner's PRIVATE bot. This route is public in src/proxy.ts for
// the same reason /api/internal is: the caller (Telegram's servers) has
// no browser session. It enforces its own checks instead, in order:
// bot token configured (else disabled) -> webhook secret header
// (fail-closed in production: no secret configured means disabled) ->
// the gating rules in services/telegram/dispatch-bot.ts
// (private chats only, chat-id allowlist, bootstrap mode before the
// allowlist exists). It never joins or reads any group and never sends
// anything except replies inside the owner's private chat.
//
// Deliberately NOT behind createApiHandler: that pipeline is built for
// session-authenticated owner requests (docs/service-specs.md); this
// caller is authenticated by the webhook secret + allowlist instead.

import { createPersonalitySenders } from "@/services/telegram/personality-send";
import {
  answerTelegramCallbackQuery,
  editTelegramMessageReplyMarkup,
  editTelegramMessageText,
  sendTelegramAskMessage,
  sendTelegramMessage,
  sendTelegramRichMessage,
  sendTelegramYesNoMessage,
} from "@/services/telegram/bot-api";
import { getTelegramAppUrl } from "@/services/telegram/cards";
import { renderSummaryCardPng } from "@/services/telegram/card-image";
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
import type { BotBrainStore } from "@/services/bot/store";
import { createTelegramBurstCollector, type TelegramBurstItem } from "@/services/telegram/burst";
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
import { formatClock, timeZoneForPosition } from "@/lib/display-zone";
import { handleTelegramVoice } from "@/services/telegram/voice-intake";

export const runtime = "nodejs";

/**
 * Telegram repairs (2026-11-03): ONE burst collector for the whole
 * process - forwarded conversations arrive as many separate webhook
 * calls and must land in the same per-chat bundle, so the collector
 * can never be rebuilt per request.
 *
 * Telegram fix round (T-002): the collector mirrors every bundle to
 * the database (migration 00083) through the brain store, so a
 * restart between Telegram's ack and the flush loses nothing. The
 * store is resolved lazily from the same env config each request
 * uses and cached - the collector itself stays process-wide.
 */
let cachedBurstBrainStore: BotBrainStore | null | undefined;
function burstBrainStore(): BotBrainStore | null {
  if (cachedBurstBrainStore === undefined) {
    cachedBurstBrainStore = createTelegramBrainStore(getTelegramConfig().companyId);
  }
  return cachedBurstBrainStore;
}

const telegramBurstCollector = createTelegramBurstCollector({
  persistence: {
    save: async (key, items, dueAtIso) => {
      const store = burstBrainStore();
      if (store) await store.savePendingBurst(key, items as unknown[], dueAtIso);
    },
    claim: async (key) => {
      const store = burstBrainStore();
      return store ? store.claimPendingBurst(key) : true;
    },
    claimDue: async () => {
      const store = burstBrainStore();
      if (!store) return [];
      const now = new Date();
      const staleBefore = new Date(now.getTime() - 5 * 60_000).toISOString();
      const claimed = await store.claimDuePendingBursts(now.toISOString(), staleBefore);
      return claimed.map((c) => ({ key: c.chatId, items: c.items as TelegramBurstItem[] }));
    },
    clear: async (key) => {
      const store = burstBrainStore();
      if (store) await store.clearPendingBurst(key);
    },
    release: async (key) => {
      const store = burstBrainStore();
      if (store) await store.releasePendingBurstClaim(key);
    },
  },
});

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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

  // T-001 fail-closed: in production the webhook secret is not optional. Without
  // one, anyone who finds this URL could post fake updates as the owner, so the
  // route refuses to process anything until the secret is configured. Local dev
  // (non-production) keeps the lenient behaviour below.
  if (!config.webhookSecret && process.env.NODE_ENV === "production") {
    console.error(
      "[telegram] WEBHOOK SECRET NOT CONFIGURED - refusing to process updates in production. Set TELEGRAM_WEBHOOK_SECRET.",
    );
    return NextResponse.json(
      { error: { code: "DISABLED", message: "Telegram webhook is not fully configured." } },
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
  const limitResult = webhookLimiter.allowWithNotice(String(chatForLimit ?? "unknown"), kind, Date.now());
  if (!limitResult.allowed) {
    console.warn("[telegram] rate limit hit - update dropped", { kind });
    // T-005: don't drop silently - tell the owner some messages were dropped.
    // The limiter throttles this notice to at most once per 10 minutes per
    // chat+kind, so the notice itself can't spam. Best-effort only: a failed
    // notice must never change the 200 acknowledgement.
    if (limitResult.notify && typeof chatForLimit === "number" && config.botToken) {
      try {
        await sendTelegramMessage(
          config.botToken,
          chatForLimit,
          "⚠️ Heads up: messages were coming in faster than I can take them, so some were dropped. Please wait a moment and send them again.",
        );
      } catch (err) {
        console.error("[telegram] rate-limit drop notice failed", err);
      }
    }
    return NextResponse.json({ ok: true });
  }

  const botToken = config.botToken;
  // Personality: stickers come from a public sticker set (TELEGRAM_STICKER_SET; default Telegram's AnimatedEmojies).
  const personality = createPersonalitySenders(botToken, { stickerSet: process.env.TELEGRAM_STICKER_SET, tenorKey: process.env.TENOR_API_KEY });
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
            autoSwitch: (detectedAtIso, submissionId, timeZone) =>
              applyAutoMotionSwitch({
                client: brainStore.client,
                companyId: brainStore.companyId,
                detectedAtIso,
                submissionId,
                nowMs: Date.now(),
                origin: "position feed",
                timeZone,
              }),
            formatTime: (t, lat, lng) => formatClock(t, timeZoneForPosition(lat, lng)),
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
      ? (userText, items, bundle) => stageRecordables(brainStore, userText, items, bundle)
      : undefined,
    // Fix 11A: filed photos join the thread's entity index (file
    // name + read identifiers), so later references resolve in code.
    indexFiledPhoto: brainStore
      ? async (chatId, filed) => {
          await brainStore.upsertThreadEntity({
            chatId,
            entityType: "document",
            entityId: filed.documentId,
            keys: [
              { kind: "file_name", value: filed.fileName },
              ...(filed.identifiers.trailerNumber ? [{ kind: "trailer_number", value: filed.identifiers.trailerNumber }] : []),
              ...(filed.identifiers.pickupNumber ? [{ kind: "pickup_number", value: filed.identifiers.pickupNumber }] : []),
              ...(filed.identifiers.sealNumber ? [{ kind: "seal_number", value: filed.identifiers.sealNumber }] : []),
            ],
            label: `document "${filed.fileName}"`,
          });
        }
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
    sendYesNoMessage: (chatId, text) => sendTelegramYesNoMessage(botToken, chatId, text),
    sendSticker: (chatId, emoji) => personality.sendSticker(chatId, emoji),
    sendGif: (chatId, query) => personality.sendGif(chatId, query),
    setReaction: (chatId, messageId, emoji) => personality.setReaction(chatId, messageId, emoji),
    sendAskMessage: (chatId, text, buttons) =>
      sendTelegramAskMessage(botToken, chatId, text, buttons),
    answerCallbackQuery: (queryId, text) =>
      answerTelegramCallbackQuery(botToken, queryId, text),
    // Rich cards (owner 2026-11-11): HTML/photo cards with inline
    // buttons + edit-in-place. All five are best-effort surfaces
    // over the plain path - an absent or failing rich dep degrades
    // to the same plain text as today, never to silence.
    sendRichMessage: (chatId, msg) => sendTelegramRichMessage(botToken, chatId, msg),
    editMessageText: (chatId, messageId, html, keyboard) =>
      editTelegramMessageText(botToken, chatId, messageId, html, keyboard),
    editMessageReplyMarkup: (chatId, messageId, keyboard) =>
      editTelegramMessageReplyMarkup(botToken, chatId, messageId, keyboard),
    renderCardImage: (title, rows) => renderSummaryCardPng(title, rows),
    appUrl: getTelegramAppUrl(),
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
