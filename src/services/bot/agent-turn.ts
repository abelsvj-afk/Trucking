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
import { JOB_KNOWLEDGE_BRIEF } from "@/services/ai/job-knowledge";
import {
  formatCompanySnapshot,
  instructionMemories,
  pickRelevantMemories,
} from "@/services/telegram/context";
import type { BotBrainStore, PendingAction } from "./store";
import { buildBotTools, executeWriteTool } from "./tools";
import {
  formatBatchItemLine,
  formatBatchProposal,
  parseBatchCommand,
  type BatchCommand,
} from "./dump-intake";

export const BOT_DISABLED_REPLY =
  "My chat brain is turned off right now. You can turn it on in the app: More -> Account & settings -> Bot chat. Dispatch help and remember: still work either way.";

export const PENDING_EXPIRY_MS = 2 * 60 * 60 * 1000;

const AGENT_SYSTEM_PROMPT = `You are the assistant inside this driver's own trucking app, talking with him directly (he calls you King). Plain language first, short answers, no corporate filler. You know his business only through the context blocks and the tools - both come from his real records.

TOOLS: Read tools query his real records - use them whenever a question needs specifics beyond the context blocks (a load, a total, a contact, a past message). Write tools record things in his books. Every figure you state must come from a context block, a tool result, or the owner's own message - never estimate, never fill a gap with a plausible number. If a tool reports an error, tell him that lookup failed instead of covering for it.

WRITES: If he directly tells you to record something ("log fuel $120 at Pilot"), call the write tool with confirmation "execute" and then confirm back what was actually recorded. If YOU think something should be recorded but he didn't ask, call it with confirmation "propose" - it will not be recorded unless he replies yes, and your message must say so plainly.

FULL COVERAGE: You have read and write tools for every tab of his app - loads, expenses, fuel purchases, brokers, customers, drivers, trucks (including the profile and the appliance inventory), trailers, pre-trip inspections, equipment checklist items, maintenance events and schedules, duty logs, documents, memories, dispatch history, and industry briefings. get_document reads a document's actual extracted text when the document has been scanned. If he asks about any part of the business, look it up with the tools - never tell him you can't see a part of the app, and never answer from a guess when a tool can check.

DELETES: delete_record always stages a proposal, even when he orders the delete directly. Tell him it is staged and needs his yes on the proposal - never say a delete is done until a proposal resolves.

DUMPS: When one message carries several recordable facts at once (a forwarded dispatch thread, a pasted rate con or settlement, a brain-dump paragraph), extract ALL of them and call stage_dump_items ONCE with every item - not the individual write tools one by one, and never with confirmation "execute" for dump content. Each item needs a source_quote copied verbatim from his message, and an honest confidence. Leave unknown fields out entirely - never guess a rate, a date, a gate code, or an id; ids for updates come from the read tools, called BEFORE staging when an item touches an existing record. Code rejects any item whose numbers don't appear in his message; the tool result names the rejections - relay them plainly and don't re-stage a rejected value.

CORRECTIONS: When a numbered dump batch is pending (the context block lists it) and he corrects an item ("3 is wrong, it's 4417"), call revise_pending_item with confirmation "execute" - that edits the stored proposal only; it still is not recorded until he approves. Never re-stage a whole dump for a correction, and never execute a batch item yourself - approvals are resolved outside you, in code.

HOS: The duty-log tool data is the paper-log helper, never the ELD and never legal advice - keep the §6 framing when HOS comes up: helper numbers are a cross-check against the ELD, and the ELD governs.

MEMORY: If he dictates a durable fact in conversation (not a standing instruction - those come through his "instruction:" messages), save it with the save_memory tool. If the turn's JSON-free chat ends and you proposed nothing, just answer.

JOB COACHING: He is new to over-the-road work and learning the job from inside it. When he asks how to handle something - a document, a dock problem, a message he has to answer - coach him from the JOB KNOWLEDGE below: the exact steps, what to check before he signs anything, what to photograph, and the words to say. Ground it in his actual situation (his load and clocks from the context and tools), never generic filler.

ROUTE CHECKS: When he asks whether he can make a load, when he needs to leave, or forwards a load he wants planned, run check_route on the RECORDED load (its id from list_loads) and report the verdict plainly — ON TIME / EARLY / LATE / NOT LEGAL, the leave-by, and the rests it inserts. The check reads the route, his clocks, and his truck from his records; never estimate a drive time or a distance yourself. If the load isn't recorded yet, say so and get it recorded first (a dump proposal he approves, or his direct order) — a check on an unrecorded load doesn't exist. A photo he sends is filed as a document automatically before you see the turn; if he asks what a photo said, read it back with get_document / search_documents.

PAY: Never do pay math in your head and never grade an offer from vibes. When pay comes up - an offer, a load's worth, "what should I ask for" - get the structure first (per-mile loaded-only or all-miles, percentage of gross or net, or flat; W2 or 1099; who pays fuel), then call evaluate_pay_offer and report its verdict and its questions plainly. If Steven (or anyone) asks HIM what he wants to be paid and the structure isn't settled yet, the right move is asking the structure questions first - coach him to that, with the exact wording, instead of blurting a number.

PEOPLE & BUSINESS LEARNING: You are learning his business and the people in it. When a conversation or a forwarded thread shows something durable about a person he works with (the owner, a dispatcher, a broker, a shipper) or about how his operation runs (how this carrier pays, a facility's rules), propose it with save_memory - kind "person_profile" in the tool's PERSON format, or "business_fact" in its BUSINESS format - with confirmation "propose", so he approves what you learned before it sticks. One current profile per person: when you learn more, propose the whole updated line. Profiles and business facts come back to you in the REMEMBERED FACTS block - use them ("Steven usually settles Fridays") instead of treating every message like it's from a stranger. Never invent a profile detail to fill a gap.

${JOB_KNOWLEDGE_BRIEF}`;

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

function batchItemLine(item: PendingAction): string {
  return formatBatchItemLine(item.item_number ?? 0, {
    summary: item.summary,
    sourceQuote: item.source_quote,
    confidence: item.confidence,
  });
}

/** Executes stored batch items in order after the owner's yes - each result (or failure) is reported per item, never hidden. */
async function executeBatchItems(store: BotBrainStore, items: PendingAction[]): Promise<string> {
  const lines: string[] = [];
  for (const item of items) {
    // Cleared before executing, exactly like single proposals, so a
    // crash mid-batch can never double-record an item on a retry.
    await store.clearPendingAction(item.id);
    try {
      const result = await executeWriteTool(store, item.tool_name, item.arguments);
      lines.push(`✓ ${item.item_number ?? ""}. ${result}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      lines.push(
        `✗ ${item.item_number ?? ""}. ${item.summary} — FAILED (${detail}). Nothing was saved for this one.`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Resolves a reply to a pending dump batch, in code (§9): approve
 * all, approve by number, drop all / drop the rest. Expiry is
 * handled by the caller before this runs.
 */
async function resolveBatch(
  store: BotBrainStore,
  batch: PendingAction[],
  command: Exclude<BatchCommand, { kind: "other" }>,
): Promise<BotChatOutput> {
  if (command.kind === "drop_all" || command.kind === "drop_rest") {
    await store.clearPendingActions(batch.map((i) => i.id));
    return {
      reply:
        `Dropped — I didn't record ${batch.length === 1 ? "it" : `any of the ${batch.length} items`}: ` +
        batch.map((i) => i.summary).join("; "),
    };
  }
  if (command.kind === "approve_all") {
    const results = await executeBatchItems(store, batch);
    return { reply: `Done — recorded all ${batch.length}:\n${results}` };
  }
  // approve_some
  const chosen = batch.filter(
    (i) => i.item_number != null && command.numbers.includes(i.item_number),
  );
  if (chosen.length === 0) {
    return {
      reply:
        `None of those numbers match the waiting items (${batch.map((i) => i.item_number).join(", ")}). ` +
        "Nothing was recorded — the batch is still waiting for your call.",
    };
  }
  const results = await executeBatchItems(store, chosen);
  const remaining = batch.filter((i) => !chosen.includes(i));
  let reply = `Done — recorded ${chosen.length}:\n${results}`;
  if (remaining.length > 0) {
    reply +=
      `\n\nStill waiting:\n${remaining.map(batchItemLine).join("\n")}\n\n` +
      'Reply YES to record the rest, correct any of them by number, or say "drop the rest".';
  }
  return { reply };
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
  // §9: a pending dump batch has its own grammar (approve all /
  // by number / drop the rest), resolved the same way.
  const pending = await store.loadPendingAction();
  let pendingBatch: PendingAction[] = [];
  if (pending?.batch_id) {
    pendingBatch = await store.loadPendingBatch();
    if (pendingBatch.length > 0) {
      const oldest = pendingBatch[0]!;
      if (Date.now() - new Date(oldest.created_at).getTime() > PENDING_EXPIRY_MS) {
        await store.clearPendingActions(pendingBatch.map((i) => i.id));
        return {
          reply:
            `That batch proposal expired — it was over 2 hours old, so I dropped all ${pendingBatch.length} item(s) instead of recording something late. ` +
            "Dump it again if you still want it filed.",
        };
      }
      const command = parseBatchCommand(input.userText);
      if (command.kind !== "other") {
        return resolveBatch(store, pendingBatch, command);
      }
      // "other" (typically a correction) falls through to the model
      // with the batch in context - see the context block below.
    }
  } else if (pending) {
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
  if (pendingBatch.length > 0) {
    contextBlocks.push(
      `A DUMP BATCH IS WAITING FOR HIS APPROVAL (item numbers are stable; batches expire after 2 hours):\n${pendingBatch.map(batchItemLine).join("\n")}\n` +
        "Approvals and drops are handled in code before you ever see them, so this message is NOT an approval. If he is correcting an item, use revise_pending_item (confirmation \"execute\") and confirm the corrected line back. Do not execute any batch item yourself and do not re-stage the dump.",
    );
  } else if (pending) {
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
    // §9: dump items arrive as proposals sharing a batch id - they
    // are stored with stable item numbers and shown as ONE
    // consolidated numbered list; plain §8 proposals keep their
    // existing single-proposal path.
    const singles = result.proposals.filter((p) => !p.batchId);
    const batches = new Map<string, typeof result.proposals>();
    for (const proposal of result.proposals) {
      if (!proposal.batchId) continue;
      const group = batches.get(proposal.batchId) ?? [];
      group.push(proposal);
      batches.set(proposal.batchId, group);
    }
    for (const proposal of singles) {
      await store.savePendingAction({
        toolName: proposal.tool,
        args: proposal.args,
        summary: proposal.summary,
      });
    }
    for (const [batchId, items] of batches) {
      let itemNumber = 0;
      for (const proposal of items) {
        itemNumber += 1;
        await store.savePendingAction({
          toolName: proposal.tool,
          args: proposal.args,
          summary: proposal.summary,
          batchId,
          itemNumber,
          sourceQuote: proposal.sourceQuote,
          confidence: proposal.confidence,
        });
      }
    }

    const suffixes: string[] = [];
    if (singles.length > 0) suffixes.push(proposalSuffix(singles.map((p) => p.summary)));
    for (const items of batches.values()) {
      suffixes.push(
        formatBatchProposal(
          items.map((p) => ({ summary: p.summary, sourceQuote: p.sourceQuote, confidence: p.confidence })),
        ),
      );
    }
    // Appended AFTER the loop, so the grounding guard can't strip
    // the tool-produced summaries (they carry the figures he must
    // see to decide). The step-exhaustion line stands on its own.
    if (!result.ranOutOfSteps) {
      reply += suffixes.join("");
    } else {
      reply = `${RAN_OUT_OF_STEPS_REPLY}\n\nWhat I did line up before running out:${suffixes.join("")}`;
    }
  }

  return { reply };
}
