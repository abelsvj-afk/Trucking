// Bot intelligence v2 (docs/design/driver-mvp.md §8). One
// conversational turn of the bot, shared by the Telegram webhook
// and the web chat route - the two surfaces differ only in which
// store (channel) and provider instance they pass in.
//
// A turn, in order:
// 1. Pending-proposal resolution. If a bot-proposed write is waiting
//    and this message is a plain yes/no, the outcome is decided in
//    CODE - no model call. Yes executes the stored write; no drops
//    it. Proposals older than 2 hours expire instead of executing,
//    so a stale yes can't write a time-wrong duty log.
// 2. Kill switch: bot_chat capability off => a fixed "turned off"
//    reply (no model call, no tools).
// 3. Otherwise the agent loop runs with the guaranteed context
//    (history + snapshot + standing instructions + retrieved
//    memories - assembled in code, same as v1), the bot's tools, and
//    the grounding guard. Any proposals the loop returns are stored
//    and named in the reply, which ends by asking for his yes.

import {
  runAgentLoop,
  RAN_OUT_OF_STEPS_REPLY,
  type AgentToolLogEntry,
} from "@/services/ai/agent-loop";
import {
  runBotChat,
  type BotChatInput,
  type BotChatOutput,
} from "@/services/ai/bot-chat";
import type { AiProvider } from "@/services/ai/provider";
import { isAgentCapableProvider } from "@/services/ai/provider";
import {
  formatCompanySnapshot,
  instructionMemories,
  pickRelevantMemories,
} from "@/services/telegram/context";
import type { BotBrainStore, PendingAction } from "./store";
import { buildBotTools, executeWriteTool } from "./tools";

export const BOT_DISABLED_REPLY =
  "My chat brain is turned off right now. You can turn it on in the app: More -> Account & settings -> Bot chat. Dispatch help and remember: still work either way.";

export const PENDING_EXPIRY_MS = 2 * 60 * 60 * 1000;

const AGENT_SYSTEM_PROMPT = `You are the assistant inside this driver's own trucking app, talking with him directly (he calls you King). Plain language first, short answers, no corporate filler. You know his business only through the context blocks and the tools - both come from his real records.

TOOLS: Read tools query his real records - use them whenever a question needs specifics beyond the context blocks (a load, a total, a contact, a past message). Write tools record things in his books. Every figure you state must come from a context block, a tool result, or the owner's own message - never estimate, never fill a gap with a plausible number. If a tool reports an error, tell him that lookup failed instead of covering for it.

WRITES: If he directly tells you to record something ("log fuel $120 at Pilot"), call the write tool with confirmation "execute" and then confirm back what was actually recorded. If YOU think something should be recorded but he didn't ask, call it with confirmation "propose" - it will not be recorded unless he replies yes, and your message must say so plainly.

HOS: The duty-log tool data is the paper-log helper, never the ELD and never legal advice - keep the §6 framing when HOS comes up: helper numbers are a cross-check against the ELD, and the ELD governs.

MEMORY: If he dictates a durable fact in conversation (not a standing instruction - those come through his "instruction:" messages), save it with the save_memory tool. If the turn's JSON-free chat ends and you proposed nothing, just answer.`;

export type ConfirmationKind = "yes" | "no" | "other";

const YES_WORDS = new Set([
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "do it", "go ahead",
  "confirm", "sí", "si", "dale", "yes do it", "yes please",
]);
const NO_WORDS = new Set([
  "no", "nope", "cancel", "drop it", "don't", "dont", "never mind",
  "nevermind", "forget it", "no thanks",
]);

export function classifyConfirmation(text: string): ConfirmationKind {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (YES_WORDS.has(normalized) || normalized.startsWith("yes ")) return "yes";
  if (NO_WORDS.has(normalized) || normalized.startsWith("no ")) return "no";
  return "other";
}

/** The code-assembled context for a conversational turn (v1's builder, reused by both surfaces). */
export async function loadBotContext(
  store: BotBrainStore,
  userText: string,
): Promise<Omit<BotChatInput, "userText">> {
  const [history, snapshot, memories] = await Promise.all([
    store.loadConversationHistory(20),
    store.loadSnapshot(),
    store.loadMemories(),
  ]);
  return {
    history,
    snapshotText: snapshot ? formatCompanySnapshot(snapshot) : null,
    instructions: instructionMemories(memories),
    memories: pickRelevantMemories(memories, userText),
  };
}

function proposalSuffix(summaries: string[]): string {
  const lines = summaries.map((s) => `- ${s}`).join("\n");
  return `\n\nI have NOT recorded this yet. Reply YES to confirm, or NO to drop it:\n${lines}`;
}

async function resolvePending(
  store: BotBrainStore,
  pending: PendingAction,
  kind: ConfirmationKind,
): Promise<BotChatOutput> {
  if (Date.now() - new Date(pending.created_at).getTime() > PENDING_EXPIRY_MS) {
    await store.clearPendingAction(pending.id);
    return {
      reply:
        `That proposal expired - it was over 2 hours old, so I dropped it instead of recording something late: ${pending.summary}. ` +
        "Tell me again if you still want it logged.",
    };
  }
  if (kind === "no") {
    await store.clearPendingAction(pending.id);
    return { reply: `Cancelled - I didn't record it: ${pending.summary}` };
  }
  await store.clearPendingAction(pending.id);
  try {
    const result = await executeWriteTool(store, pending.tool_name, pending.arguments);
    return { reply: `Done - ${result.charAt(0).toLowerCase()}${result.slice(1)}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    return {
      reply: `I tried to record it and it failed (${detail}). Nothing was saved: ${pending.summary}. Tell me how you'd like to fix it and I'll try again.`,
    };
  }
}

export interface AgentTurnHooks {
  onToolLog?: (entry: AgentToolLogEntry) => void;
}

export async function runAgentTurn(
  provider: AiProvider,
  store: BotBrainStore,
  input: BotChatInput,
  hooks: AgentTurnHooks = {},
): Promise<BotChatOutput> {
  // 1. A waiting proposal + a plain yes/no is resolved in code,
  // before any model call - deterministic, auditable, cheap.
  const pending = await store.loadPendingAction();
  if (pending) {
    const kind = classifyConfirmation(input.userText);
    if (kind !== "other") {
      return resolvePending(store, pending, kind);
    }
  }

  // 2. Kill switch (docs/governance.md): off means off, stated plainly.
  if (!(await store.isBotChatEnabled())) {
    return { reply: BOT_DISABLED_REPLY };
  }

  // A provider without tool-calling support degrades to the v1
  // single-completion chat rather than failing the turn.
  if (!isAgentCapableProvider(provider)) {
    return runBotChat(provider, input);
  }

  const contextBlocks: string[] = [];
  if (input.instructions.length > 0) {
    contextBlocks.push(`STANDING INSTRUCTIONS FROM THE OWNER:\n${input.instructions.map((i) => `- ${i}`).join("\n")}`);
  }
  if (pending) {
    contextBlocks.push(
      `A PROPOSED ACTION IS WAITING FOR HIS YES/NO (over 2 hours old proposals expire): ${pending.summary}. If he says yes or no, it is handled - anything else, answer normally and it stays waiting.`,
    );
  }
  if (input.snapshotText) contextBlocks.push(input.snapshotText);
  if (input.memories.length > 0) {
    contextBlocks.push(
      `REMEMBERED FACTS ABOUT HIM AND HIS BUSINESS:\n${input.memories.map((m) => `- ${m.content}`).join("\n")}`,
    );
  }

  const result = await runAgentLoop({
    provider,
    system: AGENT_SYSTEM_PROMPT,
    contextText: contextBlocks.join("\n\n"),
    history: input.history,
    userText: input.userText,
    tools: buildBotTools(store),
    onToolLog: hooks.onToolLog,
  });

  let reply = result.reply;
  if (result.proposals.length > 0) {
    for (const proposal of result.proposals) {
      await store.savePendingAction({
        toolName: proposal.tool,
        args: proposal.args,
        summary: proposal.summary,
      });
    }
    // Appended AFTER the loop, so the grounding guard can't strip
    // the tool-produced summaries (they carry the figures he must
    // see to decide). The step-exhaustion line stands on its own.
    if (!result.ranOutOfSteps) {
      reply += proposalSuffix(result.proposals.map((p) => p.summary));
    } else {
      reply = `${RAN_OUT_OF_STEPS_REPLY}\n\nOne thing I did line up before running out:${proposalSuffix(result.proposals.map((p) => p.summary))}`;
    }
  }

  return { reply };
}
