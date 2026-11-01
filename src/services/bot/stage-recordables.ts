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
// One batch at a time, deliberately: if any proposal is already
// waiting for his yes/no, new items are NOT staged (the caller tells
// him to settle the waiting one first), so two batches can never mix
// their item numbers.

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
  /** True when a proposal was already waiting and nothing was staged. */
  blockedByPending: boolean;
}

export async function stageRecordables(
  store: BotBrainStore,
  userText: string,
  rawItems: unknown,
): Promise<StageRecordablesResult> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { proposals: [], rejected: [], blockedByPending: false };
  }

  const pending = await store.loadPendingAction();
  if (pending) {
    return { proposals: [], rejected: [], blockedByPending: true };
  }

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

  return { proposals, rejected, blockedByPending: false };
}

/**
 * The reply suffix for a staging outcome, shared by every dispatch
 * surface so the owner hears the same words everywhere: the batch
 * proposal (when items staged), the named rejections (never silent),
 * or the settle-the-waiting-one-first note.
 */
export function formatRecordableOutcome(result: StageRecordablesResult): string {
  if (result.blockedByPending) {
    return (
      "\n\nI also spotted things in that message worth recording, but another proposal is still waiting for your yes/no. " +
      "Settle that one first, then send this message again and I'll stage them."
    );
  }
  let out = "";
  if (result.proposals.length > 0) {
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
