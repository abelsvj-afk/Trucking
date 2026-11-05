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
import { parseDispatchTrip, tripToCreateLoadArgs, type ParsedTrip } from "@/lib/dispatch-trip";
import { randomUUID } from "node:crypto";
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
  /** A readable review of a parsed trip assignment (stops, appointments, miles, tasks), when the message was one. */
  review?: string;
}

/** The clean review the owner sees before his one yes: everything read, and what is missing. */
export function tripReview(trip: ParsedTrip, brokerResolved: boolean): string {
  const lines = [`NEW TRIP ${trip.tripNumber} — ready for your review`];
  if (trip.brokerName || trip.brokerReference) {
    lines.push(`Broker: ${trip.brokerName ?? "not given"}${brokerResolved ? "" : trip.brokerName ? " (not on file yet — saved without a broker link)" : ""} · Ref: ${trip.brokerReference ?? "not given"}`);
  }
  for (const st of trip.stops) {
    lines.push(
      `Stop ${st.seq} · ${st.kind === "pickup" ? "PICKUP" : st.kind === "delivery" ? "DELIVERY" : "STOP"}: ${st.name ?? "(no name)"}`,
      `  ${st.address ?? "(no address)"}`,
      `  Appointment: ${st.appointmentText ?? "not given"}${st.appointmentAt ? "" : st.appointmentText ? " (zone not recognized — saved as text only, no time set)" : ""}`,
    );
  }
  const mi = (n: number | null) => (n === null ? "not given" : `${n.toLocaleString("en-US", { minimumFractionDigits: 2 })} mi`);
  lines.push(`Miles: deadhead ${mi(trip.deadheadMiles)} · loaded ${mi(trip.loadedMiles)} · total ${mi(trip.totalMiles)}`);
  if (trip.tasks.length > 0) lines.push("Requirements:", ...trip.tasks.map((t) => `  • ${t}`));
  return lines.join("\n");
}

export async function stageRecordables(
  store: BotBrainStore,
  userText: string,
  rawItems: unknown,
): Promise<StageRecordablesResult> {
  // A structured trip assignment is read by CODE (lib/dispatch-trip), not by
  // the model: the model path missed origin/destination on exactly this
  // message. Its create_load replaces any create_load the model proposed.
  const trip = parseDispatchTrip(userText);
  const tripArgs = trip ? tripToCreateLoadArgs(trip) : null;
  const modelItems = (Array.isArray(rawItems) ? rawItems : []).filter(
    (item) => !(tripArgs && (item as { tool_name?: unknown } | null)?.tool_name === "create_load"),
  );
  if (!tripArgs && modelItems.length === 0) {
    return { proposals: [], rejected: [], blockedByPending: false, queuedBehindPending: false };
  }

  const pending = await store.loadPendingAction();
  const queuedBehindPending = pending !== null;

  const writeRegistry = new Map(
    buildBotTools(store)
      .filter((tool) => tool.access === "write")
      .map((tool) => [tool.name, tool] as const),
  );
  const { proposals, rejected } = modelItems.length > 0
    ? validateDumpItems(userText, modelItems, writeRegistry)
    : { proposals: [] as ProposedWrite[], rejected: [] as RejectedDumpItem[] };

  let review: string | undefined;
  if (trip && tripArgs) {
    const createLoad = writeRegistry.get("create_load");
    const brokerId = trip.brokerName ? await findBrokerId(store, trip.brokerName) : null;
    if (brokerId) tripArgs.broker_id = brokerId;
    const checked = createLoad?.validateArgs ? createLoad.validateArgs(tripArgs) : { ok: true as const, args: tripArgs };
    if (createLoad && checked.ok) {
      proposals.unshift({
        tool: "create_load",
        args: checked.args,
        summary: createLoad.summarize ? createLoad.summarize(checked.args) : "Create load",
        batchId: randomUUID(),
        sourceQuote: `NEW TRIP ${trip.tripNumber}`,
        confidence: "high",
      });
      review = tripReview(trip, Boolean(brokerId));
    } else {
      rejected.push({
        summary: `Trip ${trip.tripNumber}`,
        reason: checked.ok ? "create_load is unavailable" : `not saved - ${checked.error}`,
      } as RejectedDumpItem);
    }
  }

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

  return { proposals, rejected, blockedByPending: false, queuedBehindPending, review };
}

/** Broker NAME -> id, by code (exact, case-insensitive). Ambiguous or missing -> null, never a guess. */
async function findBrokerId(store: BotBrainStore, name: string): Promise<string | null> {
  const { data, error } = await store.client
    .from("brokers")
    .select("id, name")
    .eq("company_id", store.companyId)
    .is("deleted_at", null)
    .ilike("name", name.trim());
  if (error) return null;
  const rows = ((data ?? []) as { id: string; name: string }[]).filter((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  return rows.length === 1 ? rows[0]!.id : null;
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
  let out = result.review ? `\n\n${result.review}` : "";
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
