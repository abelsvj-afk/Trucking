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
import { formatPayPinLine } from "@/services/bot/pay-pin";
import { buildLifePhaseText } from "@/services/bot/life-phase";
import { formatOpenLoopsBlock } from "@/services/bot/threads";
import type { TelegramStore } from "./store";
import type { TelegramPhotoSize } from "./photo-intake";
import type { TelegramVoice, VoiceIntakeResult } from "./voice-intake";
import { formatExemplarsBlock } from "@/services/bot/voice-corpus";

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

export interface TelegramUpdate {
  /** Telegram's delivery id - the dedup key (Lane 1, audit B-2): a redelivered update carries the same id. */
  update_id?: number;
  message?: {
    chat?: { id?: number; type?: string };
    text?: string;
    /** §13: a photo message carries renditions instead of text (plus an optional caption). */
    photo?: TelegramPhotoSize[];
    /** Phase E: a voice note (transcribed, then worked like a typed message). */
    voice?: TelegramVoice;
    caption?: string;
    forward_origin?: unknown;
    forward_from?: unknown;
    forward_date?: number;
  };
}

export interface TelegramDeps {
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
   * nothing.
   */
  handlePhoto?: (
    photo: TelegramPhotoSize[],
    caption: string | undefined,
  ) => Promise<string>;
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
  /** Null = reduced mode (no history/snapshot/memory). */
  store?: TelegramStore | null;
}

export type TelegramHandleResult =
  | "disabled"
  | "ignored_no_chat"
  | "ignored_not_private"
  | "ignored_not_allowlisted"
  | "bootstrap_replied"
  | "duplicate_ignored"
  | "dispatch_disabled"
  | "no_text_replied"
  | "photo_replied"
  | "voice_replied"
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
        ? buildLifePhaseText(payPin, await store.loadLifePhaseOverride())
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

async function processTelegramUpdate(
  update: TelegramUpdate,
  config: TelegramConfig,
  deps: TelegramDeps,
  claim: { updateId: number | null },
): Promise<TelegramHandleResult> {
  if (!config.botToken) return "disabled";

  const chat = update.message?.chat;
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

  // §13: a photo message is document intake, not conversation — it
  // runs before the text paths (a photo's caption is a note on the
  // document, never a message to answer). Same gating as everything
  // else: this point is only reached by the allowlisted private
  // chat, after the bootstrap check.
  const photo = update.message?.photo;
  if (photo && photo.length > 0) {
    const caption = update.message?.caption?.trim() || undefined;
    let reply: string;
    if (deps.handlePhoto) {
      try {
        reply = await deps.handlePhoto(photo, caption);
      } catch (err) {
        console.error("[telegram] photo intake failed", err);
        reply =
          "I got your photo but something went wrong storing it — nothing was saved. Try sending it again.";
      }
    } else {
      reply =
        "I got your photo, but photo filing isn't configured on the server yet (it needs the bot's company setup), so I couldn't store it. For now, upload it from More → Documents in the app.";
    }
    await deps.sendMessage(chat.id, reply);
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
  const intent = classifyTelegramText(text, isForwarded, "telegram");
  const ctx: LoadedContext = store
    ? await loadContext(store, chat.id, text)
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
  // Lane 1 (audit B-4): a degraded turn's reply carries the note -
  // applied at send time in every branch below.
  const withDegradedNote = (reply: string): string =>
    ctx.degraded ? reply + CONTEXT_DEGRADED_NOTE : reply;

  const persistTurn = async (assistantText: string) => {
    if (!store) return;
    try {
      await store.saveMessage(chatId, "user", voiceNote ? `[voice] ${text}` : text);
      await store.saveMessage(chatId, "assistant", assistantText);
    } catch (err) {
      console.error("[telegram] failed to persist conversation turn", err);
    }
  };

  try {
    if (intent === "remember" || intent === "instruction") {
      const content = stripCapturePrefix(text);
      const kind = intent === "instruction" ? "instruction" : memoryKindFor(content);
      let reply: string;
      if (store) {
        await store.saveMemory(kind, content);
        reply =
          kind === "instruction"
            ? `Saved as a standing instruction - I'll follow it on every reply: "${content}"`
            : kind === "expense_hint"
              ? `Saved for review: "${content}". That's captured as a note, not added to your books - add it under Money in the app if it should count.`
              : `Saved to memory: "${content}"`;
      } else {
        reply =
          "I can't store that yet - memory isn't configured on the server (TELEGRAM_COMPANY_ID / migrations). Nothing was saved.";
      }
      await deps.sendMessage(chat.id, withDegradedNote(reply));
      await persistTurn(reply);
      return intent === "instruction" ? "instruction_saved" : "remembered";
    }

    if (intent === "dispatch") {
      // Lane 1 (audit B-1): the dispatch_helper kill switch and the
      // global AI switch gate this path exactly as they gate the
      // web surfaces - off means off, stated plainly, no workup.
      if (deps.isDispatchHelperEnabled) {
        const enabled = await deps.isDispatchHelperEnabled().catch(() => false);
        if (!enabled) {
          const reply =
            "Dispatch help is turned off right now — the Dispatch helper switch (or the master AI switch) is off, so I didn't work that message over. You can turn it on in the app: More → Settings. Send the message again once it's on.";
          await deps.sendMessage(chat.id, withDegradedNote(reply));
          await persistTurn(reply);
          return "dispatch_disabled";
        }
      }
      const dispatchContext = buildDispatchContext(ctx.snapshotText, instructions, relevantMemories);
      // Phase E (twin): when the driver twin is ON, his actual sent
      // replies from similar exchanges ride the drafting context -
      // the draft is steered by his voice, not by the model's idea
      // of it. OFF (or no corpus match) = byte-identical context to
      // before, and nothing is tracked.
      let exemplarsBlock: string | null = null;
      if (store?.isDriverTwinEnabled && store?.loadVoiceExemplars) {
        try {
          if (await store.isDriverTwinEnabled()) {
            exemplarsBlock = formatExemplarsBlock(await store.loadVoiceExemplars(text));
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
        text,
        contextParts.length > 0 ? contextParts.join("\n\n") : dispatchContext,
      );
      let reply = formatDispatchSuggestion(suggestion);
      // §11: recordables the helper spotted ride the same
      // propose->yes discipline as dump intake - staged in code,
      // approved (or corrected/dropped) by his reply, resolved by
      // the agent turn's pending-batch grammar on the chat path.
      if (deps.stageRecordables && suggestion.recordable_items.length > 0) {
        try {
          const outcome = await deps.stageRecordables(text, suggestion.recordable_items);
          reply += formatRecordableOutcome(outcome);
        } catch (err) {
          console.error("[telegram] failed to stage dispatch recordables", err);
        }
      }
      await deps.sendMessage(chat.id, withDegradedNote(reply));
      if (store) {
        try {
          await store.storeExchange(text, suggestion);
        } catch (err) {
          console.error("[telegram] failed to store dispatch exchange", err);
        }
      }
      // Phase C: the same forward becomes a stored thread record
      // (participants, ask, open loop) so it outlives the scroll.
      // Best-effort: capture must never eat or delay the reply -
      // it runs after the send, and any failure is log-only.
      if (deps.captureThread) {
        try {
          await deps.captureThread(text);
        } catch (err) {
          console.error("[telegram] thread capture failed", err);
        }
      }
      await persistTurn(reply);
      return "replied";
    }

    // Conversation: questions about his business, how-do-I-handle-this,
    // dictated facts the model spots (returned in its memory field).
    // v2 (§8): with the agent wired and a store present, the agent
    // loop answers - memories go through its save_memory tool then,
    // so the v1 memory field below is simply never set on this path.
    const chatInput: BotChatInput = {
      userText: text,
      history: ctx.history,
      snapshotText: ctx.snapshotText,
      instructions,
      memories: relevantMemories,
      memoryReport: ctx.memoryReport ?? undefined,
      payPinText: ctx.payPinText,
      lifePhaseText: ctx.lifePhaseText,
      openLoopsText: ctx.openLoopsText,
    };
    if (deps.runAgent && store) {
      const agentOutput = await deps.runAgent(chatInput);
      await deps.sendMessage(chat.id, withDegradedNote(agentOutput.reply));
      await persistTurn(agentOutput.reply);
      return "chatted";
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
    await deps.sendMessage(chat.id, withDegradedNote(reply));
    await persistTurn(reply);
    return "chatted";
  } catch (err) {
    console.error("[telegram] bot turn failed", err);
    await deps.sendMessage(
      chat.id,
      "Sorry - I couldn't process that one. Try again in a moment, or paste the message into the app (More → Dispatch helper).",
    );
    return "error_replied";
  }
}
