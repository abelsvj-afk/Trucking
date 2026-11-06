// Per-turn context loading for the Telegram bot: history, memories, standing instructions,
// the facts block, pay pin, life phase, open loops, and the company snapshot - with the
// degraded-context note when any of it fails (audit B-4). Split out of dispatch-bot.ts
// (decomposition pass, behavior unchanged); dispatch-bot imports from here.

import type { BotChatInput } from "@/services/ai/bot-chat";
import { formatCompanySnapshot, instructionMemories, pickRelevantMemories, type BotMemoryRow } from "./context";
import { formatPayPinLine } from "@/services/bot/pay-pin";
import { buildLifePhaseText } from "@/services/bot/life-phase";
import { formatOpenLoopsBlock } from "@/services/bot/threads";
import type { TelegramStore } from "./store";

export interface LoadedContext {
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

export async function loadContext(store: TelegramStore, chatId: number, text: string): Promise<LoadedContext> {
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
