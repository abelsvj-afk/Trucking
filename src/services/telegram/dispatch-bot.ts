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
import type { TelegramStore } from "./store";
import type { TelegramPhotoResult, TelegramPhotoSize } from "./photo-intake";

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
    /** UH-14 fix: Telegram album grouping id, when the photo arrived as part of an album. */
    media_group_id?: string;
    caption?: string;
    forward_origin?: unknown;
    forward_from?: unknown;
    forward_date?: number;
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
  | "callback_replied"
  | "callback_ignored"
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

async function processTelegramUpdate(
  update: TelegramUpdate,
  config: TelegramConfig,
  deps: TelegramDeps,
  claim: { updateId: number | null },
): Promise<TelegramHandleResult> {
  if (!config.botToken) return "disabled";

  // §3.3: a button tap carries its chat on the callback's message,
  // not on a message of its own - the same gates apply to it below.
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
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
  const photo = update.message?.photo;
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
      await deps.sendMessage(chat.id, reply);
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
        await deps.sendMessage(chat.id, reply);
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
      await store.saveMessage(chatId, "user", text);
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
      const suggestion = await deps.getSuggestion(
        text,
        ctx.memoryReport
          ? `${dispatchContext ?? ""}\n\nCONTEXT REPORT: ${ctx.memoryReport}`.trim()
          : dispatchContext,
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
