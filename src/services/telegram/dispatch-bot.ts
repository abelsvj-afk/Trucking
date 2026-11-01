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
  message?: {
    chat?: { id?: number; type?: string };
    text?: string;
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
  /** Null = reduced mode (no history/snapshot/memory). */
  store?: TelegramStore | null;
}

export type TelegramHandleResult =
  | "disabled"
  | "ignored_no_chat"
  | "ignored_not_private"
  | "ignored_not_allowlisted"
  | "bootstrap_replied"
  | "no_text_replied"
  | "replied"
  | "remembered"
  | "instruction_saved"
  | "chatted"
  | "error_replied";

interface LoadedContext {
  history: BotChatInput["history"];
  memories: BotMemoryRow[];
  snapshotText: string | null;
}

async function loadContext(store: TelegramStore, chatId: number): Promise<LoadedContext> {
  try {
    const [history, memories, snapshot] = await Promise.all([
      store.loadHistory(chatId),
      store.loadMemories(),
      store.loadSnapshot(),
    ]);
    return {
      history,
      memories,
      snapshotText: snapshot ? formatCompanySnapshot(snapshot) : null,
    };
  } catch (err) {
    // Context is an enhancement to the reply, never a reason to eat
    // it - answer without it and log, per the fail-explicit rule.
    console.error("[telegram] failed to load bot context", err);
    return { history: [], memories: [], snapshotText: null };
  }
}

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  config: TelegramConfig,
  deps: TelegramDeps,
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

  const text = update.message?.text?.trim();
  if (!text) {
    await deps.sendMessage(
      chat.id,
      "I can only work with text for now - paste or forward the dispatch message as text and I'll translate it and draft a reply.",
    );
    return "no_text_replied";
  }

  const store = deps.store ?? null;
  const isForwarded = Boolean(
    update.message?.forward_origin ?? update.message?.forward_from ?? update.message?.forward_date,
  );
  const intent = classifyTelegramText(text, isForwarded);
  const ctx: LoadedContext = store
    ? await loadContext(store, chat.id)
    : { history: [], memories: [], snapshotText: null };
  const instructions = instructionMemories(ctx.memories);
  const relevantMemories = pickRelevantMemories(ctx.memories, text);

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
      await deps.sendMessage(chat.id, reply);
      await persistTurn(reply);
      return intent === "instruction" ? "instruction_saved" : "remembered";
    }

    if (intent === "dispatch") {
      const suggestion = await deps.getSuggestion(
        text,
        buildDispatchContext(ctx.snapshotText, instructions, relevantMemories),
      );
      const reply = formatDispatchSuggestion(suggestion);
      await deps.sendMessage(chat.id, reply);
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
    };
    if (deps.runAgent && store) {
      const agentOutput = await deps.runAgent(chatInput);
      await deps.sendMessage(chat.id, agentOutput.reply);
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
    await deps.sendMessage(chat.id, reply);
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
