// Abel forward-fix (docs/design/driver-mvp.md §11). The bridge
// between the dispatch helper's extraction and the bot's
// propose->yes staging: recordable items spotted in a forwarded or
// pasted dispatch message are validated in code (validateDumpItems -
// the same checker dump intake uses: real write tool, the tool's own
// Zod schema, a verbatim source quote, every number traced to the
// message) and stored as ONE numbered batch in bot_pending_actions.
// Nothing here records anything - execution happens only when the
// owner approves the batch, resolved in code by the agent turn.
//
// One batch ADDRESSED at a time, deliberately: approvals always
// resolve the OLDEST pending proposal first (agent-turn), so a new
// batch can never mix its item numbers with the waiting one's.
// Lane 1 (audit B-7): it used to be that a waiting proposal BLOCKED
// staging entirely - the new forward's items were dropped unless he
// re-sent the message. Now the new batch QUEUES behind the waiting
// one (own batch id, own item numbers from 1) and the reply says it
// is queued, not yet awaiting his yes.

import { buildBotTools } from "./tools";
import {
  formatBatchProposal,
  validateDumpItems,
  type RejectedDumpItem,
} from "./dump-intake";
import type { ProposedWrite } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";

export interface StageRecordablesResult {
  proposals: ProposedWrite[];
  rejected: RejectedDumpItem[];
  /** Kept for shape compatibility: staging no longer blocks (see queuedBehindPending). */
  blockedByPending: boolean;
  /** True when a proposal was already waiting and this batch was queued behind it. */
  queuedBehindPending: boolean;
}

export async function stageRecordables(
  store: BotBrainStore,
  userText: string,
  rawItems: unknown,
): Promise<StageRecordablesResult> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { proposals: [], rejected: [], blockedByPending: false, queuedBehindPending: false };
  }

  const pending = await store.loadPendingAction();
  const queuedBehindPending = pending !== null;

  const writeRegistry = new Map(
    buildBotTools(store)
      .filter((tool) => tool.access === "write")
      .map((tool) => [tool.name, tool] as const),
  );
  const { proposals, rejected } = validateDumpItems(userText, rawItems, writeRegistry);

  let itemNumber = 0;
  for (const proposal of proposals) {
    itemNumber += 1;
    await store.savePendingAction({
      toolName: proposal.tool,
      args: proposal.args,
      summary: proposal.summary,
      batchId: proposal.batchId,
      itemNumber,
      sourceQuote: proposal.sourceQuote,
      confidence: proposal.confidence,
    });
  }

  return { proposals, rejected, blockedByPending: false, queuedBehindPending };
}

/**
 * The reply suffix for a staging outcome, shared by every dispatch
 * surface so the owner hears the same words everywhere: the batch
 * proposal (when items staged), the queued note (when a proposal
 * was already waiting - the batch is filed behind it, NOT yet
 * awaiting his yes, so no YES grammar is shown for it), or the
 * named rejections (never silent).
 */
export function formatRecordableOutcome(result: StageRecordablesResult): string {
  let out = "";
  if (result.queuedBehindPending && result.proposals.length > 0) {
    const lines = result.proposals.map((p, i) => `${i + 1}. ${p.summary}`).join("\n");
    out +=
      "\n\nI also pulled things from that message worth recording and queued them behind the proposal that's already waiting — " +
      `settle that one first and I'll bring this batch up for your yes/no:\n${lines}`;
  } else if (result.proposals.length > 0) {
    out += formatBatchProposal(
      result.proposals.map((p) => ({
        summary: p.summary,
        sourceQuote: p.sourceQuote,
        confidence: p.confidence,
      })),
    );
  }
  for (const rejection of result.rejected) {
    out += `\n\nNot staged: ${rejection.summary} - ${rejection.reason}`;
  }
  return out;
}
