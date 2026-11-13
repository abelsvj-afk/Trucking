// Driver MVP (docs/design/driver-mvp.md §§4/6). The Telegram private
// bot's turn logic, kept separate from the webhook route so the rules
// are unit-testable without HTTP or a real bot.
//
// Hard rules (design §4 - do not relax without updating the design):
// - Serves ONLY the owner's private 1:1 chat. Groups are always
//   ignored; nothing is ever sent to any third party.
// - Fails closed: no bot token = disabled; an allowlist that doesn't
//   match = silently ignored; allowlist unset = bootstrap mode, which
//   replies ONLY with the chat's own id (so the owner can set the
//   allowlist) and runs no AI processing at all.
//
// Bot intelligence (design §6): every AI turn gets its context
// assembled by CODE before the call - persisted conversation history,
// a live company snapshot, the owner's standing instructions, and
// retrieved memories (services/telegram/context.ts + store.ts). The
// model never decides what to fetch. With no store configured the bot
// degrades honestly to dispatch-only replies with no context.

import { parseDispatchTrip, type ParsedTrip } from "@/lib/dispatch-trip";
import { formatReply } from "@/services/telegram/format-reply";
import {
  buildCardKeyboard,
  cardRows,
  detectCard,
  formatCardHtml,
  getTelegramAppUrl,
  structuredLineCount,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  type DetectedCard,
  type InlineKeyboard,
} from "./cards";
import {
  CARD_EDIT_MAX_AGE_MS,
  forgetCardMessage,
  lookupCardMessage,
  recordCardMessage,
} from "./card-messages";
import type { EditMessageResult, RichTelegramMessage } from "./bot-api";
import { describeIncomingMedia, extractFlair, type Flair } from "@/services/telegram/flair";
import { formatDispatchSuggestion, type DispatchSuggestion } from "@/services/ai/dispatch";
import { formatRecordableOutcome, type StageBundleContext, type StageRecordablesResult } from "@/services/bot/stage-recordables";
import type { BotChatInput, BotChatOutput } from "@/services/ai/bot-chat";
import { buildDispatchContext, classifyTelegramText, memoryKindFor, stripCapturePrefix } from "./context";
import { handleModelCorrection, handleModelRead, isModelReadRequest, parseModelCorrection } from "./model-intent";
import { type TelegramBurstCollector, type TelegramBurstItem } from "./burst";
import type { TelegramStore } from "./store";
import type { FiledPhotoInfo, TelegramPhotoResult, TelegramPhotoSize } from "./photo-intake";
import type { TelegramVoice, VoiceIntakeResult } from "./voice-intake";
import { formatExemplarsBlock } from "@/services/bot/voice-corpus";
import { forwardSourceLabel, formatForwardBundle } from "./forward-format";
import { CONTEXT_DEGRADED_NOTE, loadContext, type LoadedContext } from "./context-loader";
export { CONTEXT_DEGRADED_NOTE };
export { forwardSourceLabel, formatForwardBundle };

export interface TelegramConfig {
  botToken: string | null;
  webhookSecret: string | null;
  allowedChatId: string | null;
  companyId: string | null;
}

export function getTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  return {
    botToken: env.TELEGRAM_BOT_TOKEN || null,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || null,
    allowedChatId: env.TELEGRAM_ALLOWED_CHAT_ID || null,
    companyId: env.TELEGRAM_COMPANY_ID || null,
  };
}

export interface TelegramLocationFix {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  heading?: number;
  live_period?: number;
}

export interface TelegramUpdate {
  /** Telegram's delivery id - the dedup key (Lane 1, audit B-2): a redelivered update carries the same id. */
  update_id?: number;
  message?: {
    /** Telegram's id of the message (used to react to it). */
    message_id?: number;
    chat?: { id?: number; type?: string };
    text?: string;
    /** A sticker he sent: it reaches Abel as "[sticker 😂]", never as a command. */
    sticker?: { emoji?: string; set_name?: string };
    /** A GIF he sent: it reaches Abel as "[GIF]" plus any caption. */
    animation?: { file_id?: string };
    /** §13: a photo message carries renditions instead of text (plus an optional caption). */
    photo?: TelegramPhotoSize[];
    /**
     * Telegram repairs D1: a file sent uncompressed ("send as file")
     * arrives as a document instead of a photo - drivers send
     * paperwork this way to keep it readable, and it used to fall
     * through to the no-text reply and be silently dropped.
     */
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    /** Phase E: a voice note (transcribed, then worked like a typed message). */
    voice?: TelegramVoice;
    /** UH-14 fix: Telegram album grouping id, when the photo arrived as part of an album. */
    media_group_id?: string;
    caption?: string;
    forward_origin?: unknown;
    forward_from?: unknown;
    forward_date?: number;
    date?: number;
    /** A location share (also the first fix of a Live Location). */
    location?: TelegramLocationFix;
  };
  /**
   * Live Location (docs/design/driver-usability.md §4): every position
   * update of a live share arrives as an edited message carrying the new
   * fix - Telegram's own app sends it, even with the screen off.
   */
  edited_message?: {
    chat?: { id?: number; type?: string };
    location?: TelegramLocationFix;
    date?: number;
    edit_date?: number;
  };
  /**
   * Image Intelligence (§3.3): a tap on an inline-keyboard button
   * arrives as its own update kind - the first button surface in
   * this bot. `data` carries the photo-purpose ask's pending id +
   * the chosen purpose ("pp:<id>:<choice>").
   */
  callback_query?: {
    id?: string;
    data?: string;
    message?: {
      message_id?: number;
      /** Unix seconds the message the button sits on was sent. */
      date?: number;
      chat?: { id?: number; type?: string };
    };
  };
}

export interface TelegramDeps {
  /**
   * Live Location fixes. Absent (no company configured) = fixes are
   * ignored. Failures are logged and never reply into the chat.
   */
  handleLocation?: (loc: TelegramLocationFix, atMs: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getSuggestion: (message: string, context?: string) => Promise<DispatchSuggestion>;
  runChat: (input: BotChatInput) => Promise<BotChatOutput>;
  /**
   * Bot intelligence v2 (design §8): the agent-loop turn (tools,
   * write proposals, kill switch). When wired AND a store exists,
   * the conversational path uses this instead of runChat - the
   * context loaded above is identical; only the answering engine
   * changes. Absent = the v1 single-completion chat, unchanged.
   */
  runAgent?: (input: BotChatInput) => Promise<BotChatOutput>;
  /**
   * §11: stages recordable items extracted from a dispatch message
   * as a propose->yes batch (validation lives in the helper - the
   * items are checked in code before anything is stored). Wired
   * only when the brain store exists; absent = the workup simply
   * carries no proposals, exactly like reduced mode.
   */
  stageRecordables?: (
    userText: string,
    items: unknown,
    bundle?: StageBundleContext,
  ) => Promise<StageRecordablesResult>;
  /**
   * Lane 1 (audit B-1): the dispatch_helper kill switch (global AI
   * switch + capability row), checked before any dispatch workup on
   * Telegram - the same check the web surfaces run. Wired from the
   * brain store by the webhook; absent in reduced mode (no company
   * configured, so there are no settings to honor and no store for
   * anything the workup would feed).
   */
  isDispatchHelperEnabled?: () => Promise<boolean>;
  /**
   * §13: stores a photo message through the documents pipeline and
   * returns the plain-words reply (what was stored, extraction
   * state). Wired only when the brain store exists; absent = the
   * bot says honestly that photo filing isn't configured and stores
   * nothing. Image Intelligence (§3): the reply widens to a
   * TelegramPhotoResult - when it carries a purpose ask, the text
   * goes out with buttons (sendAskMessage) or, failing that, as a
   * numbered list resolved by the pending-question grammar.
   */
  handlePhoto?: (
    photo: TelegramPhotoSize[],
    caption: string | undefined,
    mediaGroupId?: string,
  ) => Promise<TelegramPhotoResult>;
  /**
   * Telegram fix round (fix 11A): records a just-filed photo in the
   * thread's entity index (by file name + the identifiers read from
   * it), so a later "attach it to load 1874" can find the document
   * in code. Wired from the brain store by the webhook; best-effort.
   */
  indexFiledPhoto?: (chatId: string, filed: FiledPhotoInfo) => Promise<void>;
  /**
   * Phase C: best-effort thread capture for a dispatch message -
   * reconstructs the conversation into a stored thread record
   * (services/bot/thread-capture.ts). Runs AFTER the reply and the
   * exchange store; failures are logged and never change the reply.
   * Wired only when the brain store exists.
   */
  captureThread?: (text: string) => Promise<void>;
  /**
   * Phase E: voice-note intake - downloads + transcribes the note
   * (services/telegram/voice-intake.ts) under the
   * voice_transcription kill switch. A "transcript" result flows
   * into the normal text pipeline; a "reply" result is sent as-is.
   * Absent = the bot says honestly that voice isn't configured.
   */
  handleVoice?: (voice: TelegramVoice) => Promise<VoiceIntakeResult>;
  /**
   * §3.3: sends a message with an inline keyboard (photo-purpose
   * asks). Absent = asks always go out as numbered text.
   */
  sendAskMessage?: (
    chatId: number,
    text: string,
    buttons: { text: string; callback_data: string }[][],
  ) => Promise<void>;
  /**
   * Sends a reply with a Yes / No REPLY KEYBOARD. A reply-keyboard press arrives as an ordinary text message
   * ("Yes" / "No"), so it works whatever update types the webhook is registered for - unlike an inline button,
   * whose tap needs Telegram to deliver a separate callback_query update. Absent = plain text.
   */
  sendYesNoMessage?: (chatId: number, text: string) => Promise<void>;
  /**
   * Rich cards (owner 2026-11-11): sends ONE structured card -
   * an HTML text card, or a photo card whose caption IS the full
   * card text - with its inline keyboard, and resolves the sent
   * message's Telegram id (the edit-in-place registry's key).
   * Absent = the reply goes out as plain text, exactly as today.
   * A throw means "could not send" - the caller falls back to
   * plain text, never to silence.
   */
  sendRichMessage?: (chatId: number, msg: RichTelegramMessage) => Promise<number | void>;
  /**
   * Rich cards: edits a sent card's text in place. "unchanged"
   * means the card already shows this content (send nothing new);
   * "failed" means send fresh instead. Never throws by contract.
   * Absent = no editing; every card sends fresh.
   */
  editMessageText?: (
    chatId: number,
    messageId: number,
    html: string,
    keyboard?: InlineKeyboard,
  ) => Promise<EditMessageResult>;
  /**
   * Rich cards: edits only a message's inline keyboard - the
   * Dismiss tap and the proposal-resolution cleanup. An empty
   * keyboard removes the buttons. Never throws by contract.
   */
  editMessageReplyMarkup?: (
    chatId: number,
    messageId: number,
    keyboard: InlineKeyboard,
  ) => Promise<EditMessageResult>;
  /**
   * Rich cards: renders a summary card as a PNG (sharp, already in
   * deps). Null = render failed; the HTML text card goes out
   * instead. Absent = no photo cards, text cards only.
   */
  renderCardImage?: (title: string, rows: Array<[string, string]>) => Promise<Buffer | null>;
  /** Rich cards: the live app's base URL for Open-in-app buttons. Absent = the default live domain. */
  appUrl?: string;
  /** Personality: sends a sticker for an emoji (looked up in the configured sticker set). Best-effort; absent = none. */
  sendSticker?: (chatId: number, emoji: string) => Promise<void>;
  /** Personality: sends a GIF meme for a few search words. Best-effort; absent (or no provider key) = none. */
  sendGif?: (chatId: number, query: string) => Promise<void>;
  /** Personality: reacts to his message with an emoji. Best-effort; absent = none. */
  setReaction?: (chatId: number, messageId: number, emoji: string) => Promise<void>;
  /** §3.3: acknowledges a button tap (stops Telegram's spinner). Best-effort by contract. */
  answerCallbackQuery?: (queryId: string, text?: string) => Promise<void>;
  /**
   * §3.3: resolves a photo-purpose ask from a button tap (loads
   * the staged question, settles the purpose, returns the reply
   * text). Wired from the brain store by the webhook.
   */
  resolvePhotoAsk?: (pendingId: string, choice: string) => Promise<string>;
  /**
   * §3.3/§3.4: the photo_intelligence gate for button taps - a tap
   * that lands after the owner turned the capability off settles
   * nothing. Absent = no gate (reduced mode has no asks to tap).
   */
  isPhotoIntelligenceEnabled?: () => Promise<boolean>;
  /** Null = reduced mode (no history/snapshot/memory). */
  store?: TelegramStore | null;
  /**
   * Telegram repairs (2026-11-03): the burst collector. When
   * wired (the webhook wires one process-wide instance), text
   * updates are collected per chat and flushed as ONE bundle
   * turn - see services/telegram/burst.ts. Absent = every text
   * update is worked immediately as its own turn (the pre-repair
   * behavior, kept for reduced/test surfaces).
   */
  burstCollector?: TelegramBurstCollector;
}

export type TelegramHandleResult =
  | "disabled"
  | "ignored_no_chat"
  | "ignored_not_private"
  | "ignored_not_allowlisted"
  | "bootstrap_replied"
  | "duplicate_ignored"
  | "burst_queued"
  | "dispatch_disabled"
  | "no_text_replied"
  | "photo_replied"
  | "voice_replied"
  | "callback_replied"
  | "callback_ignored"
  | "location_recorded"
  | "location_ignored"
  | "edit_ignored"
  | "replied"
  | "remembered"
  | "instruction_saved"
  | "chatted"
  | "error_replied";

// ---------------------------------------------------------------------------
// Telegram repairs (2026-11-03): burst/bundle text turns. One code
// path works a single message and a collected bundle: the items
// are partitioned into capture dictations, forwarded content
// (ONE dispatch workup over the whole bundle), and the owner's
// own words (ONE conversation turn) - and the caller sends
// exactly ONE consolidated reply.
// ---------------------------------------------------------------------------

interface ProcessedTextTurn {
  result: TelegramHandleResult;
  reply: string;
  degraded: boolean;
  /** False only for the error turn (mirrors the pre-repair behavior: a failed turn leaves no timeline trace). */
  persist: boolean;
  /** Dispatch bookkeeping (exchange store + thread capture) that must run only AFTER the reply actually sent. */
  afterSend?: () => Promise<void>;
  /** A sticker / reaction Abel asked for (already vetted: none on a serious message). */
  flair?: Flair;
}

/** True only when Abel actually asked for a sticker or a reaction - the normal reply awaits nothing extra. */
const wantsFlair = (flair: Flair | undefined): flair is Flair => Boolean(flair && (flair.sticker || flair.reaction || flair.gif));

/** Sends the sticker and reaction Abel asked for, after the text. Never fails the turn. */
async function sendFlair(deps: TelegramDeps, chatId: number, flair: Flair | undefined, messageId?: number): Promise<void> {
  if (!flair) return;
  if (flair.sticker && deps.sendSticker) {
    try {
      await deps.sendSticker(chatId, flair.sticker);
    } catch (err) {
      console.error("[telegram] sticker failed (the text already went out)", err instanceof Error ? err.message : "error");
    }
  }
  if (flair.gif && deps.sendGif) {
    try {
      await deps.sendGif(chatId, flair.gif);
    } catch (err) {
      console.error("[telegram] gif failed (the text already went out)", err instanceof Error ? err.message : "error");
    }
  }
  if (flair.reaction && messageId !== undefined && deps.setReaction) {
    try {
      await deps.setReaction(chatId, messageId, flair.reaction);
    } catch (err) {
      console.error("[telegram] reaction failed (the text already went out)", err instanceof Error ? err.message : "error");
    }
  }
}

const BARE_CONFIRMATION = /^(yes|no|yeah|nope|ok|okay)[.!]?$/i;

/**
 * Works one text turn - a singleton or a whole bundle - and
 * returns the ONE reply for it. Never sends, never persists the
 * timeline: the caller does both, once, so a bundle can never
 * fan out into N replies. Internal failures resolve to the
 * apology turn, exactly like the pre-repair single-message path.
 */
async function processTextItems(
  items: TelegramBurstItem[],
  chatId: number,
  deps: TelegramDeps,
  options?: {
    /** Photos filed at this bundle's flush, forwarded WITH the text (brief fixes 7-9). */
    documents?: FiledPhotoInfo[];
    /** The photo intake replies for those photos (used when they don't ride a dispatch bundle). */
    photoReplies?: string[];
    /** ChatGPT T-004: the dedup claim failed - this turn is read-only. */
    writesRefused?: boolean;
  },
): Promise<ProcessedTextTurn> {
  const store = deps.store ?? null;
  const ctx: LoadedContext = store
    ? await loadContext(store, chatId, items.map((i) => i.text).join("\n"))
    : {
        history: [],
        memories: [],
        instructions: [],
        relevantMemories: [],
        memoryReport: null,
        lessonRecallText: null,
        payPinText: null,
        lifePhaseText: null,
        openLoopsText: null,
        snapshotText: null,
        degraded: false,
      };
  const instructions = ctx.instructions;
  const relevantMemories = ctx.relevantMemories;

  try {
    const captureItems = items.filter(
      (i) => !i.isForwarded && classifyTelegramText(i.text, false, "telegram") !== "chat",
    );
    const forwardItems = items.filter((i) => i.isForwarded);
    const chatItems = items.filter(
      (i) => !i.isForwarded && classifyTelegramText(i.text, false, "telegram") === "chat",
    );
    const combinedForward =
      forwardItems.length === 1
        ? forwardItems[0]!.text
        : forwardItems.length > 1
          ? formatForwardBundle(forwardItems)
          : null;

    const segments: string[] = [];
    let afterSend: (() => Promise<void>) | undefined;
    let dispatchDisabled = false;
    /** The trip a forwarded dispatch in this turn parsed to (null when none did) — the card header keys off it. */
    let dispatchTrip: ParsedTrip | null = null;

    // --- photos filed with this bundle (fix round) --------------
    // When they ride a forwarded dispatch bundle, the trip review
    // carries the attach lines; the segment here just confirms the
    // filing. Otherwise the intake replies ARE the segment.
    if (options?.photoReplies && options.photoReplies.length > 0) {
      if (forwardItems.length > 0 && (options.documents?.length ?? 0) > 0) {
        segments.push(options.documents!.map((d) => `📎 "${d.fileName}" — filed with this bundle.`).join("\n"));
      } else {
        segments.push(options.photoReplies.join("\n\n"));
      }
    }

    // --- capture dictations (remember: / instruction:) ---------
    for (const item of captureItems) {
      const intent = classifyTelegramText(item.text, false, "telegram");
      const content = stripCapturePrefix(item.text);
      const kind = intent === "instruction" ? "instruction" : memoryKindFor(content);
      if (store && options?.writesRefused) {
        segments.push(
          `I couldn't safely save that this turn — a storage hiccup kept me from verifying the message wasn't a duplicate, so nothing was recorded: "${content}". Say it again in a moment.`,
        );
      } else if (store) {
        await store.saveMemory(kind, content);
        segments.push(
          kind === "instruction"
            ? `Saved as a standing instruction - I'll follow it on every reply: "${content}"`
            : kind === "expense_hint"
              ? `Saved for review: "${content}". That's captured as a note, not added to your books - add it under Money in the app if it should count.`
              : `Saved to memory: "${content}"`,
        );
      } else {
        segments.push(
          "I can't store that yet - memory isn't configured on the server (TELEGRAM_COMPANY_ID / migrations). Nothing was saved.",
        );
      }
    }

    // --- forwarded content: ONE dispatch workup over the bundle -
    if (forwardItems.length > 0 && combinedForward) {
      // Lane 1 (audit B-1): the dispatch_helper kill switch and
      // the global AI switch gate this path exactly as they gate
      // the web surfaces - off means off, stated plainly.
      let enabled = true;
      if (deps.isDispatchHelperEnabled) {
        enabled = await deps.isDispatchHelperEnabled().catch(() => false);
      }
      if (!enabled) {
        dispatchDisabled = true;
        segments.push(
          "Dispatch help is turned off right now — the Dispatch helper switch (or the master AI switch) is off, so I didn't work that message over. You can turn it on in the app: More → Settings. Send the message again once it's on.",
        );
      } else {
        const dispatchContext = buildDispatchContext(ctx.snapshotText, instructions, relevantMemories);
        // Phase E (twin): his actual sent replies from similar
        // exchanges steer the draft when the twin is on.
        let exemplarsBlock: string | null = null;
        if (store?.isDriverTwinEnabled && store?.loadVoiceExemplars) {
          try {
            if (await store.isDriverTwinEnabled()) {
              exemplarsBlock = formatExemplarsBlock(await store.loadVoiceExemplars(combinedForward));
            }
          } catch (err) {
            console.error("[telegram] twin exemplar load failed", err);
          }
        }
        const contextParts = [
          dispatchContext ?? "",
          ctx.memoryReport ? `CONTEXT REPORT: ${ctx.memoryReport}` : "",
          exemplarsBlock ?? "",
        ].filter(Boolean);
        const suggestion = await deps.getSuggestion(
          combinedForward,
          contextParts.length > 0 ? contextParts.join("\n\n") : dispatchContext,
        );
        // P2-3 (telegram audit 2026-11-06): a recognized trip assignment needs no "who is this /
        // what are they asking" guess - it is dispatch assigning a trip, and the staged load says the rest.
        const trip = parseDispatchTrip(combinedForward);
        dispatchTrip = trip;
        let reply = trip
          ? `That's dispatch assigning Trip ${trip.tripNumber}.` +
            (suggestion.suggested_reply ? `\n\nSuggested reply:\n${suggestion.suggested_reply}` : "")
          : formatDispatchSuggestion(suggestion);
        // §11: recordables ride the same propose->yes discipline.
        // T-004: never staged on a read-only (claim-failed) turn.
        if (deps.stageRecordables && !options?.writesRefused && (suggestion.recordable_items.length > 0 || trip)) {
          try {
            const outcome = await deps.stageRecordables(combinedForward, suggestion.recordable_items, {
              chatId: String(chatId),
              documents: options?.documents,
            });
            reply += formatRecordableOutcome(outcome);
          } catch (err) {
            console.error("[telegram] failed to stage dispatch recordables", err);
          }
        } else if (options?.writesRefused && (suggestion.recordable_items.length > 0 || trip)) {
          reply +=
            "\n\nI worked that over, but I didn't stage anything from it — a storage hiccup kept me from verifying the message wasn't a duplicate. Send it again in a moment and I'll line it all up for your yes.";
        }
        segments.push(reply);
        const bundleText = combinedForward;
        afterSend = async () => {
          if (store) {
            try {
              await store.storeExchange(bundleText, suggestion);
            } catch (err) {
              console.error("[telegram] failed to store dispatch exchange", err);
            }
          }
          // Phase C: the bundle becomes ONE thread record set -
          // capture receives the same combined text the workup
          // (and the exchange store) saw, so its exact-match
          // exchange link holds under batching.
          if (deps.captureThread) {
            try {
              await deps.captureThread(bundleText);
            } catch (err) {
              console.error("[telegram] thread capture failed", err);
            }
          }
        };
      }
    }

    // --- the owner's own words: ONE conversation turn ----------
    if (chatItems.length > 0) {
      // Frontier 2 (/model): a model read or a correct-by-reply is
      // handled in CODE, never by the model — the read renders the
      // stored model verbatim, and a correction is STAGED as a
      // proposal (never auto-applied). These are intent triggers,
      // not a command system: anything else stays conversation.
      // Items handled here never reach the agent turn.
      const modelItems: TelegramBurstItem[] = [];
      const remainingChatItems: TelegramBurstItem[] = [];
      for (const item of chatItems) {
        if (isModelReadRequest(item.text) || parseModelCorrection(item.text)) modelItems.push(item);
        else remainingChatItems.push(item);
      }
      for (const item of modelItems) {
        if (isModelReadRequest(item.text)) {
          segments.push(await handleModelRead(store));
        } else {
          segments.push(
            (await handleModelCorrection(store, item.text, { writesRefused: options?.writesRefused })).reply,
          );
        }
      }
      const chatItemsForTurn = remainingChatItems;
      // A bare yes/no may be answering a staged proposal - it
      // reaches the agent EXACTLY as typed (never wrapped in
      // bundle context), so the pending-batch grammar still
      // parses it. Other owner items combine into one turn; the
      // forwarded bundle rides that turn's context block.
      const confirmations = chatItemsForTurn.filter((i) => BARE_CONFIRMATION.test(i.text.trim()));
      const rest = chatItemsForTurn.filter((i) => !BARE_CONFIRMATION.test(i.text.trim()));
      const calls: { userText: string; includeBundle: boolean }[] = [
        ...confirmations.map((i) => ({ userText: i.text, includeBundle: false })),
        ...(rest.length > 0
          ? [{ userText: rest.map((i) => i.text).join("\n"), includeBundle: forwardItems.length > 0 }]
          : []),
      ];
      const replies: string[] = [];
      for (const call of calls) {
        const snapshotText =
          call.includeBundle && combinedForward
            ? [ctx.snapshotText, `FORWARDED MESSAGE BUNDLE (context he just sent):\n${combinedForward}`]
                .filter(Boolean)
                .join("\n\n")
            : ctx.snapshotText;
        const chatInput: BotChatInput = {
          userText: call.userText,
          history: ctx.history,
          snapshotText,
          instructions,
          memories: relevantMemories,
          memoryReport: ctx.memoryReport ?? undefined,
          lessonRecallText: ctx.lessonRecallText,
          payPinText: ctx.payPinText,
          lifePhaseText: ctx.lifePhaseText,
          openLoopsText: ctx.openLoopsText,
          // Fix round: the thread key enables code-side reference
          // resolution + the entity index; T-004 makes the turn
          // read-only when the dedup claim failed.
          chatId: String(chatId),
          writesRefused: options?.writesRefused,
        };
        if (deps.runAgent && store) {
          const agentOutput = await deps.runAgent(chatInput);
          replies.push(agentOutput.reply);
          continue;
        }
        const output = await deps.runChat(chatInput);
        let reply = output.reply;
        if (output.memory && store && options?.writesRefused) {
          reply += "\n\n(I'd save that to memory, but this turn was read-only — a storage hiccup. Nothing was saved.)";
        } else if (output.memory && store) {
          try {
            await store.saveMemory(output.memory.kind, output.memory.content);
            reply += "\n\n(Saved that to memory.)";
          } catch (err) {
            console.error("[telegram] failed to save chat memory", err);
          }
        } else if (output.memory && !store) {
          reply += "\n\n(I'd save that to memory, but memory isn't configured on the server yet.)";
        }
        replies.push(reply);
      }
      segments.push(...replies);
    }

    const result: TelegramHandleResult =
      chatItems.length > 0
        ? "chatted"
        : forwardItems.length > 0
          ? dispatchDisabled
            ? "dispatch_disabled"
            : "replied"
          : captureItems.some(
                (i) => classifyTelegramText(i.text, false, "telegram") === "instruction",
              )
            ? "instruction_saved"
            : "remembered";
    // Owner 2026-11-07: no raw markdown stars - clean, emoji-labelled text, before it is sent AND before it is stored.
    // Personality markers ({{sticker:..}} / {{react:..}}) are pulled out first and never stored or shown.
    const flair = extractFlair(segments.join("\n\n"));
    // Cards fix: a trip workup / staged proposal without a card
    // header gets a code-built one, so it rides a card (with its
    // Yes/No buttons) instead of a wall of text. The words below
    // the header are untouched.
    const headed = ensureLoadCardHeader(flair.text, dispatchTrip, chatItems.length === 0);
    return { result, reply: formatReply(headed), degraded: ctx.degraded, persist: true, afterSend, flair };
  } catch (err) {
    console.error("[telegram] bot turn failed", err);
    return {
      result: "error_replied",
      reply:
        "Sorry - I couldn't process that one. Try again in a moment, or paste the message into the app (More → Dispatch helper).",
      degraded: ctx.degraded,
      persist: false,
    };
  }
}

/** D12: one line when a turn's persist failed after its retry + dead letter. */
const PERSIST_FAILED_WARNING = "I couldn't save that to your record — still done, just not stored";

/** Persists a worked text turn: each original item once as his message, the ONE reply once as Abel's. Returns false when the persist failed (the store retried + dead-lettered first) so the caller can warn him. */
async function persistTextTurn(
  store: TelegramStore | null,
  chatId: number,
  items: TelegramBurstItem[],
  assistantText: string,
): Promise<boolean> {
  if (!store) return true;
  try {
    for (const item of items) {
      await store.saveMessage(chatId, "user", item.voiceNote ? `[voice] ${item.text}` : item.text);
    }
    await store.saveMessage(chatId, "assistant", assistantText);
    return true;
  } catch (err) {
    console.error("[telegram] failed to persist conversation turn", err);
    return false;
  }
}

/** Best-effort: the warning itself must never break a turn that already went out. */
async function warnPersistFailed(deps: TelegramDeps, chatId: number): Promise<void> {
  try {
    await sendReply(deps, chatId, PERSIST_FAILED_WARNING);
  } catch (err) {
    console.error("[telegram] persist-failed warning send failed", err);
  }
}

/**
 * Telegram fix round: works ONE flushed bundle - text items and
 * any photos that joined it - and sends exactly ONE consolidated
 * reply. Photos are filed FIRST, in arrival order, so a photo
 * forwarded with dispatch text exists (with its read identifiers)
 * by the time the text turn stages the load it belongs to; the
 * attach then rides the same proposal batch (fixes 7-9). A photo
 * that fails to store says so in the reply - never silently lost.
 */
async function flushBundleTurn(
  chatId: number,
  deps: TelegramDeps,
  store: TelegramStore | null,
  items: TelegramBurstItem[],
): Promise<void> {
  const mediaItems = items.filter((i) => i.media);
  const textItems = items.filter((i) => !i.media);
  const documents: FiledPhotoInfo[] = [];
  const photoReplies: string[] = [];
  for (const item of mediaItems) {
    const media = item.media!;
    if (!deps.handlePhoto) {
      photoReplies.push(
        "I got a photo with that bundle, but photo filing isn't configured on the server yet, so I couldn't store it. For now, upload it from More → Documents in the app.",
      );
      continue;
    }
    try {
      const result = await deps.handlePhoto(media.photo, media.caption ?? (item.text || undefined), media.mediaGroupId);
      if (typeof result === "string") {
        photoReplies.push(result);
      } else {
        let text = result.text;
        if (result.ask) {
          // Inside a bundle the ask rides the consolidated reply as
          // a numbered list (the solo path's buttons don't fit one
          // combined message); the pending question itself is the
          // same, and a number/name answer resolves it as always.
          text += `\n${result.ask.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}\n(Reply with a number — or just tell me what it is.)`;
        }
        photoReplies.push(text);
        if (result.filed) {
          documents.push(result.filed);
          if (deps.indexFiledPhoto) {
            try {
              await deps.indexFiledPhoto(String(chatId), result.filed);
            } catch (err) {
              console.error("[telegram] filed-photo indexing failed", err);
            }
          }
        }
      }
    } catch (err) {
      console.error("[telegram] bundle photo intake failed", err);
      photoReplies.push("One photo in that bundle wouldn't store — nothing was saved for it. Send it again on its own and I'll file it.");
    }
  }

  if (textItems.length === 0) {
    const reply = photoReplies.join("\n\n") || "Got it.";
    await sendPhotoReply(deps, chatId, reply);
    if (store) {
      try {
        for (const item of mediaItems) {
          await store.saveMessage(chatId, "user", item.media?.caption ? `[photo] ${item.media.caption}` : "[photo]");
        }
        await store.saveMessage(chatId, "assistant", reply);
      } catch (err) {
        // D12: the store retried + dead-lettered; say so instead of
        // silently holding the only copy in memory.
        console.error("[telegram] failed to persist photo bundle turn", err);
        await sendPhotoReply(deps, chatId, PERSIST_FAILED_WARNING);
      }
    }
    return;
  }

  const outcome = await processTextItems(textItems, chatId, deps, { documents, photoReplies });
  await sendReply(deps, chatId, outcome.degraded ? outcome.reply + CONTEXT_DEGRADED_NOTE : outcome.reply);
  const lastItem = textItems[textItems.length - 1] ?? mediaItems[mediaItems.length - 1];
  if (wantsFlair(outcome.flair)) await sendFlair(deps, chatId, outcome.flair, lastItem?.messageId);
  if (outcome.afterSend) await outcome.afterSend();
  if (outcome.persist) {
    if (store && mediaItems.length > 0) {
      try {
        for (const item of mediaItems) {
          await store.saveMessage(chatId, "user", item.media?.caption ? `[photo] ${item.media.caption}` : "[photo]");
        }
      } catch (err) {
        console.error("[telegram] failed to persist bundle photo markers", err);
      }
    }
    const saved = await persistTextTurn(store, chatId, textItems, outcome.reply);
    if (!saved) await warnPersistFailed(deps, chatId);
  }
}

/**
 * The flush/error handler pair for one chat's bundles - shared by
 * the text enqueue, the photo join, and the T-002 recovery sweep,
 * so every path works a bundle the same way. The error handler
 * releases every update claim in the bundle (CD-6 widened), so a
 * failed flush is redelivered by Telegram instead of swallowed.
 */
function makeBundleHandlers(
  chatId: number,
  deps: TelegramDeps,
  store: TelegramStore | null,
): {
  flush: (items: TelegramBurstItem[]) => Promise<void>;
  onError: (items: TelegramBurstItem[]) => Promise<void>;
} {
  return {
    flush: (items) => flushBundleTurn(chatId, deps, store, items),
    onError: async (items) => {
      if (store?.releaseTelegramUpdate) {
        for (const item of items) {
          if (item.updateId === undefined) continue;
          try {
            await store.releaseTelegramUpdate(item.updateId);
          } catch (err) {
            console.error(
              "[telegram] FAILED to release a burst update claim after a failed bundle flush - " +
                "Telegram's redelivery of that update will be ignored as a duplicate",
              err,
            );
          }
        }
      }
    },
  };
}

/**
 * Fix round (pitfall hunt CD-6): the claim/release wrapper. Lane 1's
 * dedup claimed the update_id BEFORE processing, which buys
 * no-duplicates at a price nobody named: if the turn then fails -
 * above all when the reply SEND fails - Telegram's redelivery hits
 * the standing claim and the message is dropped forever, with the
 * turn possibly never persisted. This wrapper releases the claim
 * whenever processing escapes with an error (the turn did NOT
 * complete), so the webhook's error return lets Telegram redeliver
 * and the retry reprocesses. Turns that complete - including ones
 * that complete by apologizing - keep their claim: reprocessing
 * them would double-apply their writes. The release is best-effort;
 * if it fails, that is logged loudly, because a dropped message is
 * exactly what a human needs to hear about.
 */
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  config: TelegramConfig,
  deps: TelegramDeps,
): Promise<TelegramHandleResult> {
  const claim: { updateId: number | null } = { updateId: null };
  try {
    return await processTelegramUpdate(update, config, deps, claim);
  } catch (err) {
    if (claim.updateId !== null && deps.store?.releaseTelegramUpdate) {
      try {
        await deps.store.releaseTelegramUpdate(claim.updateId);
      } catch (releaseErr) {
        console.error(
          "[telegram] FAILED to release the update claim after a failed turn - " +
            "Telegram's redelivery of this update will be ignored as a duplicate and the message may be lost",
          releaseErr,
        );
      }
    }
    throw err;
  }
}

const CALLBACK_DATA_PATTERN = /^pp:([0-9a-fA-F-]{36}):([a-z_]+)$/;
/** A card's Dismiss tap: "dismiss:<card key>" - hides the buttons, settles nothing, writes nothing. */
const DISMISS_DATA_PATTERN = /^dismiss:([a-z]+:[A-Za-z0-9-]+)$/;
/** A proposal's tap-to-answer buttons: the tap is exactly the typed "yes" / "no" (same code path, same rules). */
const YES_NO_DATA_PATTERN = /^yn:(yes|no)$/;
/** A tap on an old message is refused - the same freshness window a casual "ok" gets. */
const YES_NO_TAP_MAX_AGE_SECONDS = 10 * 60;
/** True when a reply is asking for his yes/no on something staged ("Reply YES to ..."). */
export function asksForYesNo(text: string): boolean {
  return /\bReply YES\b/.test(text);
}

const EMOJI_LED_FIRST_LINE = /^[\p{Extended_Pictographic}⭐✅❌]/u;

/**
 * Cards fix (owner 2026-11-12): ANY structured information Abel
 * presents must arrive as a clean card, never a wall of text. The
 * detector needs a card header as the first line, so a trip workup
 * or staged proposal that lacks one gets a code-built header
 * prepended here — the words below it are untouched.
 *
 * Fires only when the reply is really about one trip AND carries at
 * least two structured fact lines, AND either (a) this turn worked
 * a forwarded dispatch that parsed to that trip (dispatch-only
 * turn — the workup dominates the reply), or (b) the reply asks
 * for his yes/no on staged items (a proposal, whether code-built
 * or agent-written). A verbatim read never asks for yes/no and is
 * never a dispatch workup, so the verbatim guard stands. A prose
 * question or clarification ("which one do you mean") asks
 * nothing and stays plain.
 */
export function ensureLoadCardHeader(
  text: string,
  dispatchTrip: ParsedTrip | null,
  dispatchOnlyTurn: boolean,
): string {
  const first = String(text ?? "").split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  if (EMOJI_LED_FIRST_LINE.test(first)) return text;
  const tripNo =
    dispatchTrip?.tripNumber ?? /Trip (\d{3,6})/.exec(text)?.[1] ?? null;
  if (!tripNo) return text;
  if (structuredLineCount(text) < 2) return text;
  const isTripWorkup = dispatchTrip !== null && (dispatchOnlyTurn || asksForYesNo(text));
  const isTripProposal = dispatchTrip === null && asksForYesNo(text);
  if (!isTripWorkup && !isTripProposal) return text;
  return `🚚 Load — Trip ${tripNo}\n\n${text}`;
}

/**
 * The fields card sending actually uses — a caller passes only
 * these (the webhook reuses sendReply for live-location proposals
 * without dragging in the whole bot dependency bag).
 */
export type CardSendDeps = Pick<
  TelegramDeps,
  "sendMessage" | "sendYesNoMessage" | "sendRichMessage" | "editMessageText" | "renderCardImage" | "appUrl"
>;

/**
 * Rich cards (owner 2026-11-11): sends one summary card - HTML
 * text, or a photo whose caption IS the full card text - with its
 * buttons, editing the live card for the same thing in place when
 * there is one. Returns true when the card went out (sent, edited,
 * or already showing this content); false when the caller should
 * fall back to the plain path. A proposal card NEVER edits in
 * place: a pending yes must stay visible as sent, not be replaced
 * under him. The words are never changed - only <b> tags and
 * buttons are added, and the timeline still stores the plain text.
 */
async function sendCardReply(
  deps: CardSendDeps,
  chatId: number,
  text: string,
  card: DetectedCard,
): Promise<boolean> {
  if (!deps.sendRichMessage) return false;
  const appUrl = deps.appUrl ?? getTelegramAppUrl();
  const proposal = asksForYesNo(text);
  const keyboard = buildCardKeyboard(card, { appUrl, proposal });
  const html = formatCardHtml(text);

  // Edit-in-place: the same thing already has a live card.
  if (!proposal) {
    const existing = lookupCardMessage(chatId, card.key);
    if (existing && deps.editMessageText && Date.now() - existing.sentAtMs < CARD_EDIT_MAX_AGE_MS) {
      if (existing.html === html) return true; // already showing exactly this - send nothing new
      let result: EditMessageResult;
      try {
        result = await deps.editMessageText(chatId, existing.messageId, html, keyboard);
      } catch (err) {
        console.error("[telegram] card edit failed; sending fresh", err instanceof Error ? err.message : err);
        result = "failed";
      }
      if (result === "edited") {
        recordCardMessage(chatId, card.key, existing.messageId, html);
        return true;
      }
      if (result === "unchanged") return true;
      forgetCardMessage(chatId, card.key); // fall through to a fresh send
    }
  }

  // Fresh send: a photo card when the whole card fits in a caption
  // (the image adds nothing the caption lacks), else an HTML card.
  if (html.length <= TELEGRAM_CAPTION_LIMIT && deps.renderCardImage) {
    const { title, rows } = cardRows(text);
    let png: Buffer | null = null;
    try {
      png = await deps.renderCardImage(title, rows);
    } catch (err) {
      console.error("[telegram] card image render failed; sending the text card", err instanceof Error ? err.message : err);
    }
    if (png) {
      try {
        const id = await deps.sendRichMessage(chatId, { kind: "photo", html, photoPng: png, keyboard });
        if (typeof id === "number") recordCardMessage(chatId, card.key, id, html);
        return true;
      } catch (err) {
        console.error("[telegram] photo card send failed; sending the text card", err instanceof Error ? err.message : err);
      }
    }
  }
  if (html.length > TELEGRAM_MESSAGE_LIMIT) return false; // too long for one HTML message - plain chunked text
  try {
    const id = await deps.sendRichMessage(chatId, { kind: "text", html, keyboard });
    if (typeof id === "number") recordCardMessage(chatId, card.key, id, html);
    return true;
  } catch (err) {
    console.error("[telegram] rich card send failed; sending plain text", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Sends a reply; when it asks for a yes/no, big Yes / No keys ride along (gloves, a truck). A key press is an
 * ordinary "Yes" / "No" message, so it needs no special webhook setting. Keys failing or unsupported degrade to
 * the same text - he can always just type it. (Inline "yn:" taps from older messages are still handled below.)
 * A load / pay / HOS summary goes out as ONE rich card instead (same words, bold headers, Open-in-app + Dismiss),
 * with the plain path as the fallback for every failure.
 *
 * Exported: the webhook routes non-conversational sends (live-location duty proposals) through this same
 * detection, so a structured notice cards instead of arriving as a wall of plain text.
 */
export async function sendReply(deps: CardSendDeps, chatId: number, text: string): Promise<void> {
  const card = detectCard(text);
  if (card && (await sendCardReply(deps, chatId, text, card))) return;
  if (deps.sendYesNoMessage && asksForYesNo(text)) {
    try {
      await deps.sendYesNoMessage(chatId, text);
      return;
    } catch (err) {
      console.error("[telegram] yes/no keyboard send failed; sending plain text", err);
    }
  }
  await deps.sendMessage(chatId, text);
}

/**
 * §3.3: resolves one inline-keyboard tap. The tap settles a
 * photo's PURPOSE only - never a record write (any write the
 * purpose implies is staged by the purpose's own pipeline and
 * still needs his yes). Every failure mode answers the callback
 * so Telegram stops spinning, and says plainly what happened.
 */
async function handleCallbackQuery(
  query: NonNullable<TelegramUpdate["callback_query"]>,
  chatId: number,
  deps: TelegramDeps,
  store: TelegramStore | null,
): Promise<TelegramHandleResult> {
  const answer = async (text?: string): Promise<void> => {
    if (!query.id || !deps.answerCallbackQuery) return;
    try {
      await deps.answerCallbackQuery(query.id, text);
    } catch (err) {
      console.error("[telegram] answerCallbackQuery failed", err);
    }
  };

  const yesNo = typeof query.data === "string" ? query.data.match(YES_NO_DATA_PATTERN) : null;
  if (yesNo) {
    const sentAt = query.message?.date;
    if (typeof sentAt === "number" && Date.now() / 1000 - sentAt > YES_NO_TAP_MAX_AGE_SECONDS) {
      await answer("That one's a while back - just tell me yes or no in words.");
      return "callback_ignored";
    }
    await answer();
    const item: TelegramBurstItem = { text: yesNo[1]!, isForwarded: false, voiceNote: false };
    const outcome = await processTextItems([item], chatId, deps);
    await sendReply(deps, chatId, outcome.degraded ? outcome.reply + CONTEXT_DEGRADED_NOTE : outcome.reply);
    // The tap settled the proposal - take its buttons off the
    // message so a later tap can't answer the same question twice.
    // Best-effort: the outcome reply already went out.
    if (query.message?.message_id !== undefined && deps.editMessageReplyMarkup) {
      try {
        await deps.editMessageReplyMarkup(chatId, query.message.message_id, []);
      } catch (err) {
        console.error("[telegram] clearing proposal buttons failed (the answer already went out)", err instanceof Error ? err.message : err);
      }
    }
    if (wantsFlair(outcome.flair)) await sendFlair(deps, chatId, outcome.flair);
    if (outcome.afterSend) await outcome.afterSend();
    if (outcome.persist) {
      const saved = await persistTextTurn(store, chatId, [item], outcome.reply);
      if (!saved) await warnPersistFailed(deps, chatId);
    }
    return "callback_replied";
  }
  // Rich cards: Dismiss hides the buttons and settles nothing -
  // a pending proposal (if any) stays pending for a typed answer,
  // and the card leaves the edit registry so a later refresh sends
  // fresh instead of resurrecting a dismissed card.
  const dismiss = typeof query.data === "string" ? query.data.match(DISMISS_DATA_PATTERN) : null;
  if (dismiss) {
    const key = dismiss[1]!;
    if (query.message?.message_id !== undefined && deps.editMessageReplyMarkup) {
      await answer();
      try {
        await deps.editMessageReplyMarkup(chatId, query.message.message_id, []);
      } catch (err) {
        console.error("[telegram] dismiss button-clear failed", err instanceof Error ? err.message : err);
      }
      forgetCardMessage(chatId, key);
    } else {
      await answer("Dismissed.");
    }
    return "callback_replied";
  }
  const match = typeof query.data === "string" ? query.data.match(CALLBACK_DATA_PATTERN) : null;
  if (!match) {
    await answer("That button doesn't work anymore.");
    return "callback_ignored";
  }
  const [, pendingId, choice] = match as unknown as [string, string, string];

  // §3.4: the capability gate applies to taps too - off means the
  // question settles nothing (the photo stays stored-unfiled).
  if (deps.isPhotoIntelligenceEnabled) {
    const enabled = await deps.isPhotoIntelligenceEnabled().catch(() => false);
    if (!enabled) {
      await answer("Photo understanding is turned off right now.");
      return "callback_ignored";
    }
  }

  if (!deps.resolvePhotoAsk) {
    await answer("Photo buttons aren't set up in this mode.");
    return "callback_ignored";
  }

  const reply = await deps.resolvePhotoAsk(pendingId!, choice!);
  await answer();
  await deps.sendMessage(chatId, reply);
  if (store) {
    try {
      await store.saveMessage(chatId, "user", `[photo tap] ${choice}`);
      await store.saveMessage(chatId, "assistant", reply);
    } catch (err) {
      console.error("[telegram] failed to persist callback turn", err);
    }
  }
  return "callback_replied";
}

/**
 * Doc-intake hunt DH-3: sends the photo branch's reply without ever
 * throwing. By the time the intake returns, the document store (and
 * any staged proposals) has COMMITTED - if the reply send then threw,
 * the CD-6 wrapper would release the update claim and Telegram's
 * redelivery would run the intake again, storing the same photo a
 * second time with a second proposal batch. A lost reply is the
 * lesser harm (the document is in his app either way); a duplicated
 * document is not. Loud log, swallowed error.
 */
async function sendPhotoReply(deps: TelegramDeps, chatId: number, text: string): Promise<void> {
  try {
    await deps.sendMessage(chatId, text);
  } catch (err) {
    console.error(
      "[telegram] photo reply send failed after the photo was stored - keeping the update claim so redelivery cannot duplicate the document",
      err,
    );
  }
}

async function processTelegramUpdate(
  update: TelegramUpdate,
  config: TelegramConfig,
  deps: TelegramDeps,
  claim: { updateId: number | null },
): Promise<TelegramHandleResult> {
  if (!config.botToken) return "disabled";

  // §3.3: a button tap carries its chat on the callback's message,
  // not on a message of its own - the same gates apply to it below.
  const chat = update.message?.chat ?? update.edited_message?.chat ?? update.callback_query?.message?.chat;
  if (!chat || typeof chat.id !== "number") return "ignored_no_chat";
  const chatId = chat.id;
  if (chat.type !== "private") return "ignored_not_private";

  if (config.allowedChatId && String(chat.id) !== config.allowedChatId) {
    return "ignored_not_allowlisted";
  }

  if (!config.allowedChatId) {
    await deps.sendMessage(
      chat.id,
      [
        "Setup mode - this bot is not locked to its owner yet, so it won't process messages.",
        "",
        `Your chat id is: ${chat.id}`,
        "",
        "Set it as the TELEGRAM_ALLOWED_CHAT_ID secret (see docs/design/driver-mvp.md §4), redeploy, and then send me a dispatch message.",
      ].join("\n"),
    );
    return "bootstrap_replied";
  }

  const store = deps.store ?? null;

  // Lane 1 (audit B-2): claim this update BEFORE any processing.
  // Telegram redelivers an update when the reply send fails or the
  // request times out, and writes execute inside a turn - without
  // the claim, a redelivery could log the same fuel purchase twice
  // or store the same photo twice.
  //
  // ChatGPT T-004 (fix round): when the claim call itself FAILS,
  // dedup is not established for this update - the old code
  // proceeded at full power, so a redelivery could double-apply a
  // write. Now the turn runs READ-ONLY: reads proceed (the failure
  // is logged loudly), and every write path below checks
  // claimFailed and refuses. No write without established dedup.
  let claimFailed = false;
  if (store && typeof update.update_id === "number" && store.claimTelegramUpdate) {
    let claimed = false;
    try {
      claimed = await store.claimTelegramUpdate(update.update_id);
      // CD-6: remember the claim so the wrapper can release it if
      // this turn never completes. Recorded only when the claim
      // actually landed (a claim call that threw recorded nothing).
      if (claimed) claim.updateId = update.update_id;
    } catch (err) {
      claimFailed = true;
      console.error("[telegram] update claim FAILED - this turn runs read-only, writes refused (T-004)", err);
    }
    if (!claimed && !claimFailed) return "duplicate_ignored";
  }

  // T-002 recovery sweep: bundles persisted by an earlier process
  // (or by a flush that died) are claimed and worked here, before
  // this update - exactly one consolidated response each.
  if (deps.burstCollector?.recoverDue) {
    try {
      await deps.burstCollector.recoverDue((key) => {
        const recoveredChatId = Number(key);
        const handlers = makeBundleHandlers(Number.isNaN(recoveredChatId) ? chatId : recoveredChatId, deps, store);
        return { flush: handlers.flush, onError: handlers.onError };
      });
    } catch (err) {
      console.error("[telegram] burst recovery sweep failed", err);
    }
  }

  // Live Location: a position fix (the first share or an edit of it) is
  // data, not conversation - it never gets a chat reply of its own.
  const locationFix = update.edited_message?.location ?? update.message?.location;
  if (locationFix) {
    // T-004: recording a position is a write - refused when dedup
    // could not be established. No reply exists for location, so
    // the refusal is the log line and the dropped fix.
    if (claimFailed) {
      console.error("[telegram] location fix refused - update claim failed (T-004)");
      return "location_ignored";
    }
    if (!deps.handleLocation) return "location_ignored";
    const stamp = update.edited_message?.edit_date ?? update.edited_message?.date ?? update.message?.date;
    const atMs = typeof stamp === "number" ? stamp * 1000 : Date.now();
    try {
      await deps.handleLocation(locationFix, atMs);
    } catch (err) {
      console.error("[telegram] live location failed", err);
      return "location_ignored";
    }
    return "location_recorded";
  }

  // Doc-intake hunt DH-5: an edit-only update (he fixed a caption or
  // a typo; Telegram re-delivers the message as an edit) carries no
  // new message, photo, or tap to work. Falling through would land
  // in the no-text branch and answer his edit with the boilerplate
  // explainer - a junk reply to a non-message. Ignore it silently.
  // (Live-location edits were already consumed above.)
  if (!update.message && !update.callback_query) return "edit_ignored";

  // §3.3: a button tap is resolved here, after the same gates and
  // the same dedup claim as every other update kind (acceptance
  // A2: a double-tap or a Telegram retry of the tap hits the claim
  // above and never settles twice).
  if (update.callback_query) {
    // T-004: a tap settles a photo purpose (a write) - refused when
    // dedup could not be established. The tap is answered so
    // Telegram stops spinning, and he is told nothing changed.
    if (claimFailed) {
      if (update.callback_query.id && deps.answerCallbackQuery) {
        try {
          await deps.answerCallbackQuery(update.callback_query.id, "Storage hiccup — nothing was changed. Try again in a moment.");
        } catch (err) {
          console.error("[telegram] answerCallbackQuery failed", err);
        }
      }
      return "callback_ignored";
    }
    return handleCallbackQuery(update.callback_query, chatId, deps, store);
  }

  // §13: a photo message is document intake, not conversation — it
  // runs before the text paths (a photo's caption is a note on the
  // document, never a message to answer). Same gating as everything
  // else: this point is only reached by the allowlisted private
  // chat, after the bootstrap check.
  //
  // Telegram repairs D1: an IMAGE sent "as a file" (message.document)
  // is a photo for intake purposes - route it through the same
  // handler with its single rendition. A non-image file (a PDF)
  // gets an honest answer instead of the old silent drop: the
  // photo pipeline can't read it, and pretending otherwise would
  // store it mislabeled.
  const documentMessage = update.message?.document;
  let photo = update.message?.photo;
  if ((!photo || photo.length === 0) && documentMessage?.file_id) {
    if (documentMessage.mime_type?.startsWith("image/")) {
      photo = [{ file_id: documentMessage.file_id, file_size: documentMessage.file_size }];
    } else {
      const caption = update.message?.caption?.trim() || undefined;
      const reply =
        `I got ${documentMessage.file_name ?? "that file"}, but it came through as a file — I can only read things sent as photos right now, so I didn't store it. ` +
        "Send it again as a photo (not \"send as file\") and I'll read it and file it; a PDF can also go in through More → Documents in the app.";
      await deps.sendMessage(chat.id, reply);
      if (store) {
        try {
          await store.saveMessage(chatId, "user", caption ? `[document] ${caption}` : "[document]");
          await store.saveMessage(chatId, "assistant", reply);
        } catch (err) {
          console.error("[telegram] failed to persist document turn", err);
        }
      }
      return "photo_replied";
    }
  }
  if (photo && photo.length > 0) {
    const caption = update.message?.caption?.trim() || undefined;
    // T-004: filing a photo is a write - refused when the update's
    // dedup claim could not be established.
    if (claimFailed) {
      const reply =
        "I got your photo, but I hit a storage hiccup verifying the message, so I didn't store it — filing it now could store it twice if the message gets delivered again. Send it once more in a moment and I'll file it.";
      await sendPhotoReply(deps, chat.id, reply);
      if (store) {
        try {
          await store.saveMessage(chatId, "user", caption ? `[photo] ${caption}` : "[photo]");
          await store.saveMessage(chatId, "assistant", reply);
        } catch (err) {
          console.error("[telegram] failed to persist refused photo turn", err);
        }
      }
      return "photo_replied";
    }
    // Brief fix 7: a photo that arrives while a bundle for this
    // chat is collecting JOINS the bundle - it is filed at the
    // flush and worked as one package with the text (the Trip 1874
    // shape: dispatch forwards, then the trailer photo). No open
    // bundle = the solo path below, unchanged.
    if (deps.burstCollector?.collectMedia) {
      const handlers = makeBundleHandlers(chatId, deps, store);
      const joined = deps.burstCollector.collectMedia(
        String(chatId),
        {
          updateId: typeof update.update_id === "number" ? update.update_id : undefined,
          text: caption ?? "",
          isForwarded: Boolean(
            update.message?.forward_origin ?? update.message?.forward_from ?? update.message?.forward_date,
          ),
          messageId: update.message?.message_id,
          media: {
            kind: "photo",
            photo,
            caption,
            mediaGroupId: update.message?.media_group_id,
            sentAt: update.message?.date,
          },
        },
        handlers.flush,
        handlers.onError,
      );
      if (joined) return "burst_queued";
    }
    let result: TelegramPhotoResult | null = null;
    let reply: string;
    if (deps.handlePhoto) {
      try {
        const mediaGroupId = update.message?.media_group_id;
        result = mediaGroupId
          ? await deps.handlePhoto(photo, caption, mediaGroupId)
          : await deps.handlePhoto(photo, caption);
      } catch (err) {
        console.error("[telegram] photo intake failed", err);
        result =
          "I got your photo but something went wrong storing it — nothing was saved. Try sending it again.";
      }
    } else {
      result =
        "I got your photo, but photo filing isn't configured on the server yet (it needs the bot's company setup), so I couldn't store it. For now, upload it from More → Documents in the app.";
    }
    if (typeof result === "string") {
      reply = result;
      await sendPhotoReply(deps, chat.id, reply);
    } else {
      // §3.3: a purpose ask goes out with buttons when the surface
      // supports them; button delivery failing (or unsupported)
      // degrades to the SAME choices as a numbered text list -
      // the fallback is permanent, not an error path. The text
      // persisted to the timeline is the text he actually saw.
      reply = result.text;
      let sentWithButtons = false;
      if (result.ask && deps.sendAskMessage) {
        try {
          const rows = result.ask.options.map((option) => ({
            text: option.label,
            callback_data: `pp:${result.ask!.pendingId}:${option.choice}`,
          }));
          // Two buttons per row - tappable with gloves, at a truck.
          const buttons: { text: string; callback_data: string }[][] = [];
          for (let i = 0; i < rows.length; i += 2) buttons.push(rows.slice(i, i + 2));
          await deps.sendAskMessage(chat.id, result.text, buttons);
          sentWithButtons = true;
        } catch (err) {
          console.error("[telegram] ask button send failed; falling back to numbered text", err);
        }
      }
      if (!sentWithButtons) {
        if (result.ask) {
          const numbered = result.ask.options
            .map((option, i) => `${i + 1}. ${option.label}`)
            .join("\n");
          reply = `${result.text}\n\n${numbered}\n\n(Reply with a number — or just tell me what it is.)`;
        }
        await sendPhotoReply(deps, chat.id, reply);
      }
    }
    // Fix 11A: a solo photo joins the thread index too, so the
    // NEXT message ("attach it to load 1874") can find it in code.
    if (result && typeof result !== "string" && result.filed && deps.indexFiledPhoto) {
      try {
        await deps.indexFiledPhoto(String(chatId), result.filed);
      } catch (err) {
        console.error("[telegram] filed-photo indexing failed", err);
      }
    }
    if (store) {
      try {
        await store.saveMessage(chatId, "user", caption ? `[photo] ${caption}` : "[photo]");
        await store.saveMessage(chatId, "assistant", reply);
      } catch (err) {
        console.error("[telegram] failed to persist photo turn", err);
      }
    }
    return "photo_replied";
  }

  // Phase E: a voice note is transcribed and then worked EXACTLY
  // like a typed message (same pipeline, same brain) - the
  // transcript becomes this turn's text, and the timeline keeps a
  // "[voice]" marker so he can see how it arrived. Intake failures
  // (capability off / not configured / download failed) reply
  // plainly and store nothing beyond the marker + that reply.
  let voiceNote = false;
  const voice = update.message?.voice;
  if (voice) {
    if (!deps.handleVoice) {
      const reply =
        "I got your voice note, but voice transcription isn't configured on the server yet, so I couldn't turn it into text. Type it for now and I'll work it the same way.";
      await deps.sendMessage(chat.id, reply);
      if (store) {
        try {
          await store.saveMessage(chatId, "user", "[voice]");
          await store.saveMessage(chatId, "assistant", reply);
        } catch (err) {
          console.error("[telegram] failed to persist voice turn", err);
        }
      }
      return "voice_replied";
    }
    const outcome = await deps.handleVoice(voice);
    if (outcome.kind === "reply") {
      await deps.sendMessage(chat.id, outcome.text);
      if (store) {
        try {
          await store.saveMessage(chatId, "user", "[voice]");
          await store.saveMessage(chatId, "assistant", outcome.text);
        } catch (err) {
          console.error("[telegram] failed to persist voice turn", err);
        }
      }
      return "voice_replied";
    }
    voiceNote = true;
    update = { ...update, message: { ...update.message, text: outcome.text } };
  }

  // A sticker or GIF is not a command and not "no text": it reaches Abel as "[sticker 😂]" / "[GIF]".
  const text = update.message?.text?.trim() || describeIncomingMedia(update.message ?? {}) || undefined;
  if (!text) {
    await deps.sendMessage(
      chat.id,
      "I work with text and photos — paste or forward the dispatch message as text and I'll work it over (who's asking, what they want, a reply draft if you need one), or send a photo of paperwork and I'll file it as a document.",
    );
    return "no_text_replied";
  }

  const isForwarded = Boolean(
    update.message?.forward_origin ?? update.message?.forward_from ?? update.message?.forward_date,
  );
  const item: TelegramBurstItem = {
    updateId: typeof update.update_id === "number" ? update.update_id : undefined,
    text,
    isForwarded,
    sourceLabel: forwardSourceLabel(update.message),
    voiceNote,
    messageId: update.message?.message_id,
  };

  // Telegram repairs (2026-11-03): with the burst collector wired,
  // this text update joins the chat's pending bundle and the ONE
  // consolidated turn runs when the bundle flushes. The claim made
  // above stays in force across the wait (dedup is unaffected);
  // if the flush itself fails, every claim in the bundle is
  // released (CD-6 widened to the bundle) so Telegram's redelivery
  // reprocesses instead of being swallowed as duplicates.
  if (deps.burstCollector && !claimFailed) {
    const handlers = makeBundleHandlers(chatId, deps, store);
    deps.burstCollector.enqueue(String(chatId), item, handlers.flush, handlers.onError);
    return "burst_queued";
  }

  // T-004: on a claim-failed turn the bundle is skipped too (its
  // flush could outlive the failure and write later) - the turn is
  // worked immediately, read-only.
  const outcome = await processTextItems([item], chatId, deps, { writesRefused: claimFailed });
  await sendReply(deps, chatId, outcome.degraded ? outcome.reply + CONTEXT_DEGRADED_NOTE : outcome.reply);
  if (wantsFlair(outcome.flair)) await sendFlair(deps, chatId, outcome.flair, item.messageId);
  if (outcome.afterSend) await outcome.afterSend();
  if (outcome.persist) {
    const saved = await persistTextTurn(store, chatId, [item], outcome.reply);
    if (!saved) await warnPersistFailed(deps, chatId);
  }
  return outcome.result;
}
