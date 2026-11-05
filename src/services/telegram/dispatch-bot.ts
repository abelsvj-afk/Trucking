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

import { parseDispatchTrip } from "@/lib/dispatch-trip";
import {
  formatDispatchSuggestion,
  type DispatchSuggestion,
} from "@/services/ai/dispatch";
import {
  formatRecordableOutcome,
  type StageRecordablesResult,
} from "@/services/bot/stage-recordables";
import type { BotChatInput, BotChatOutput } from "@/services/ai/bot-chat";
import {
  buildDispatchContext,
  classifyTelegramText,
  formatCompanySnapshot,
  instructionMemories,
  memoryKindFor,
  pickRelevantMemories,
  stripCapturePrefix,
  type BotMemoryRow,
} from "./context";
import {
  type TelegramBurstCollector,
  type TelegramBurstItem,
} from "./burst";
import { formatPayPinLine } from "@/services/bot/pay-pin";
import { buildLifePhaseText } from "@/services/bot/life-phase";
import { formatOpenLoopsBlock } from "@/services/bot/threads";
import type { TelegramStore } from "./store";
import type { TelegramPhotoResult, TelegramPhotoSize } from "./photo-intake";
import type { TelegramVoice, VoiceIntakeResult } from "./voice-intake";
import { formatExemplarsBlock } from "@/services/bot/voice-corpus";

import { forwardSourceLabel, formatForwardBundle } from "./forward-format";
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
    chat?: { id?: number; type?: string };
    text?: string;
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

interface LoadedContext {
  history: BotChatInput["history"];
  memories: BotMemoryRow[];
  /** Lane 2: standing instructions, loaded in full on their own query (never relevance-filtered, never windowed). */
  instructions: BotMemoryRow[];
  /** Lane 2: the facts block for this turn - hybrid retrieval over ALL current facts when the store supports it. */
  relevantMemories: BotMemoryRow[];
  /** Lane 2: the retrieval self-report line (null on the legacy path). */
  memoryReport: string | null;
  /** Phase D: the pay pin block (pin or NOT-PINNED instruction), loaded whenever the store supports it. */
  payPinText: string | null;
  /** Phase C: the life-phase framing block (pin-aware; his "Life phase" fact overrides). */
  lifePhaseText: string | null;
  /** Phase C: unanswered asks from recorded threads, when any exist. */
  openLoopsText: string | null;
  snapshotText: string | null;
  /** Lane 1 (audit B-4): true when the context load failed and the turn is answering without his records - the reply must SAY so. */
  degraded: boolean;
}

async function loadContext(store: TelegramStore, chatId: number, text: string): Promise<LoadedContext> {
  try {
    const [history, snapshot] = await Promise.all([
      store.loadHistory(chatId),
      store.loadSnapshot(),
    ]);
    const snapshotText = snapshot ? formatCompanySnapshot(snapshot) : null;
    // Lane 2 (Phase A): when the store carries the Lane 2 retrieval
    // surface (the shared brain store does), instructions and facts
    // come from hybrid retrieval over the whole store - the
    // newest-100 load + keyword pick no longer touches context
    // assembly. Older store shapes (test doubles, the v1 store)
    // keep the legacy path below.
    // Phase D: the pay pin rides every Telegram turn too (optional
    // method - older store shapes simply skip the block).
    const payPin = store.loadPayPin ? await store.loadPayPin() : null;
    const payPinText = payPin ? formatPayPinLine(payPin) : null;
    // Phase C: life phase (derived from the same pin; his stored
    // override wins) + open loops from recorded threads.
    const lifePhaseText =
      payPin && store.loadLifePhaseOverride
        ? buildLifePhaseText(
            payPin,
            await store.loadLifePhaseOverride(),
            store.loadActiveEmployer ? await store.loadActiveEmployer() : null,
          )
        : null;
    const openLoopsText = store.listThreads
      ? formatOpenLoopsBlock(
          await store.listThreads({ openOnly: true, unansweredOnly: true, limit: 3 }),
        )
      : null;
    if (store.retrieveFacts && store.loadInstructionMemories) {
      const [instructions, retrieval] = await Promise.all([
        store.loadInstructionMemories(),
        store.retrieveFacts(text),
      ]);
      return {
        history,
        memories: retrieval.facts as BotMemoryRow[],
        instructions: instructions as BotMemoryRow[],
        relevantMemories: retrieval.facts as BotMemoryRow[],
        memoryReport: retrieval.reportLine,
        payPinText,
        lifePhaseText,
        openLoopsText,
        snapshotText,
        degraded: false,
      };
    }
    const memories = await store.loadMemories();
    return {
      history,
      memories,
      instructions: instructionMemories(memories),
      relevantMemories: pickRelevantMemories(memories, text),
      memoryReport: null,
      payPinText,
      lifePhaseText,
      openLoopsText,
      snapshotText,
      degraded: false,
    };
  } catch (err) {
    // Context is an enhancement to the reply, never a reason to eat
    // it - answer without it, log it, and (Lane 1, B-4) TELL him:
    // a silently dumber answer is the failure this flag exists to
    // prevent. Callers append CONTEXT_DEGRADED_NOTE to the reply.
    console.error("[telegram] failed to load bot context", err);
    return {
      history: [],
      memories: [],
      instructions: [],
      relevantMemories: [],
      memoryReport: null,
      payPinText: null,
      lifePhaseText: null,
      openLoopsText: null,
      snapshotText: null,
      degraded: true,
    };
  }
}

/** Appended to any reply produced on a turn whose context failed to load (audit B-4). */
export const CONTEXT_DEGRADED_NOTE =
  "\n\n(Heads up: I couldn't pull up your records for that one, so I answered without your history, memories, and snapshot — I may be missing context.)";

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

    // --- capture dictations (remember: / instruction:) ---------
    for (const item of captureItems) {
      const intent = classifyTelegramText(item.text, false, "telegram");
      const content = stripCapturePrefix(item.text);
      const kind = intent === "instruction" ? "instruction" : memoryKindFor(content);
      if (store) {
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
        let reply = formatDispatchSuggestion(suggestion);
        // §11: recordables ride the same propose->yes discipline.
        if (deps.stageRecordables && (suggestion.recordable_items.length > 0 || parseDispatchTrip(combinedForward))) {
          try {
            const outcome = await deps.stageRecordables(combinedForward, suggestion.recordable_items);
            reply += formatRecordableOutcome(outcome);
          } catch (err) {
            console.error("[telegram] failed to stage dispatch recordables", err);
          }
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
      // A bare yes/no may be answering a staged proposal - it
      // reaches the agent EXACTLY as typed (never wrapped in
      // bundle context), so the pending-batch grammar still
      // parses it. Other owner items combine into one turn; the
      // forwarded bundle rides that turn's context block.
      const confirmations = chatItems.filter((i) => BARE_CONFIRMATION.test(i.text.trim()));
      const rest = chatItems.filter((i) => !BARE_CONFIRMATION.test(i.text.trim()));
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
          payPinText: ctx.payPinText,
          lifePhaseText: ctx.lifePhaseText,
          openLoopsText: ctx.openLoopsText,
        };
        if (deps.runAgent && store) {
          const agentOutput = await deps.runAgent(chatInput);
          replies.push(agentOutput.reply);
          continue;
        }
        const output = await deps.runChat(chatInput);
        let reply = output.reply;
        if (output.memory && store) {
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
    return { result, reply: segments.join("\n\n"), degraded: ctx.degraded, persist: true, afterSend };
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

/** Persists a worked text turn: each original item once as his message, the ONE reply once as Abel's. */
async function persistTextTurn(
  store: TelegramStore | null,
  chatId: number,
  items: TelegramBurstItem[],
  assistantText: string,
): Promise<void> {
  if (!store) return;
  try {
    for (const item of items) {
      await store.saveMessage(chatId, "user", item.voiceNote ? `[voice] ${item.text}` : item.text);
    }
    await store.saveMessage(chatId, "assistant", assistantText);
  } catch (err) {
    console.error("[telegram] failed to persist conversation turn", err);
  }
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
  // or store the same photo twice. A failed claim check (store
  // trouble) never eats the message: the turn proceeds and the
  // context load below degrades honestly if the store is down.
  if (store && typeof update.update_id === "number" && store.claimTelegramUpdate) {
    let claimed = true;
    try {
      claimed = await store.claimTelegramUpdate(update.update_id);
      // CD-6: remember the claim so the wrapper can release it if
      // this turn never completes. Recorded only when the claim
      // actually landed (a claim call that threw recorded nothing).
      if (claimed) claim.updateId = update.update_id;
    } catch (err) {
      console.error("[telegram] update claim failed", err);
    }
    if (!claimed) return "duplicate_ignored";
  }

  // Live Location: a position fix (the first share or an edit of it) is
  // data, not conversation - it never gets a chat reply of its own.
  const locationFix = update.edited_message?.location ?? update.message?.location;
  if (locationFix) {
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

  const text = update.message?.text?.trim();
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
  };

  // Telegram repairs (2026-11-03): with the burst collector wired,
  // this text update joins the chat's pending bundle and the ONE
  // consolidated turn runs when the bundle flushes. The claim made
  // above stays in force across the wait (dedup is unaffected);
  // if the flush itself fails, every claim in the bundle is
  // released (CD-6 widened to the bundle) so Telegram's redelivery
  // reprocesses instead of being swallowed as duplicates.
  if (deps.burstCollector) {
    deps.burstCollector.enqueue(
      String(chatId),
      item,
      async (bundleItems) => {
        const outcome = await processTextItems(bundleItems, chatId, deps);
        await deps.sendMessage(
          chatId,
          outcome.degraded ? outcome.reply + CONTEXT_DEGRADED_NOTE : outcome.reply,
        );
        if (outcome.afterSend) await outcome.afterSend();
        if (outcome.persist) await persistTextTurn(store, chatId, bundleItems, outcome.reply);
      },
      async (bundleItems) => {
        if (store?.releaseTelegramUpdate) {
          for (const bundleItem of bundleItems) {
            if (bundleItem.updateId === undefined) continue;
            try {
              await store.releaseTelegramUpdate(bundleItem.updateId);
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
    );
    return "burst_queued";
  }

  const outcome = await processTextItems([item], chatId, deps);
  await deps.sendMessage(
    chatId,
    outcome.degraded ? outcome.reply + CONTEXT_DEGRADED_NOTE : outcome.reply,
  );
  if (outcome.afterSend) await outcome.afterSend();
  if (outcome.persist) await persistTextTurn(store, chatId, [item], outcome.reply);
  return outcome.result;
}
