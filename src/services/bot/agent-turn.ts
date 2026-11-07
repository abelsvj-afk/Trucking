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
import { randomUUID } from "node:crypto";
import type { AiProvider } from "@/services/ai/provider";
import { isAgentCapableProvider } from "@/services/ai/provider";
import { JOB_KNOWLEDGE_BRIEF } from "@/services/ai/job-knowledge";
import { formatCompanySnapshot } from "@/services/telegram/context";
import {
  listPendingResearchRequests,
  requestPhotoItems,
  requestReason,
} from "@/services/research/requests";
import type { BotBrainStore, PendingAction } from "./store";
import { formatPayPinLine } from "./pay-pin";
import { buildLifePhaseText } from "./life-phase";
import { formatOpenLoopsBlock } from "./threads";
import { buildBotTools, executeWriteTool } from "./tools";
import { gateExecutes } from "./execute-gate";
import { stripConfirmationProse } from "./reply-prose";
import { STYLE_RULES } from "@/services/telegram/format-reply";
import { FLAIR_RULES } from "@/services/telegram/flair";
import { savedWhere } from "./saved-where";
import { reconcileProposals } from "./reconcile-proposals";
import { expandMaintenancePairings } from "./maintenance-pairing";
import { annotatePaperLogEdits } from "@/services/fleet/paper-logs";
import {
  PHOTO_PURPOSE_TOOL,
  tryResolvePhotoPurposeAsk,
  type PhotoPurposeAskArgs,
} from "@/services/telegram/photo-purpose";
import {
  formatBatchItemLine,
  formatBatchProposal,
  parseBatchCommand,
  type BatchCommand,
} from "./dump-intake";

export const BOT_DISABLED_REPLY =
  "My chat brain is turned off right now. You can turn it on in the app: More -> Account & settings -> Bot chat. Dispatch help and remember: still work either way.";

export const PENDING_EXPIRY_MS = 2 * 60 * 60 * 1000;
/** A proposal shown this recently is what a bare yes/no means. */
export const SHOWN_RECENTLY_MS = 10 * 60 * 1000;

const AGENT_SYSTEM_PROMPT = `You are the assistant inside this driver's own trucking app, talking with him directly (he calls you Abel). Plain language first, short answers, no corporate filler. CANCEL IS NOT DELETE: when he says no / remove that / drop that about something you just suggested, that only cancels the suggestion - never propose deleting a saved record unless he names that saved record and asks to delete it. FORGETTING: when he asks you to forget or remove something you remember, find it with list_memories and PROPOSE delete_record (entity memory) - never claim it is forgotten until he says yes. Every id you pass to a tool (broker, customer, driver, load) must be a real id from a read tool, never a name; if you cannot find it, say so and ask. COMPLETED LOADS: when he says he delivered / finished / completed a load, find it with list_loads (his one active load, or ask which) and use complete_load with the delivery date - never record_load_decision for a delivery, and never invent a load. CHANGE FIELDS, NOT NOTES: when he corrects a value ("delivery should say the 6th"), change that field with the update tool; a note is not a correction. Never change a load's status unless he asks for that. REPORT ONLY WHAT HAPPENED: say only what the tool results show was changed (their "Now:" lines), and never narrate internal failures or tool names to him - say plainly what was and wasn't done. Don't close threads or log decisions he didn't mention. You know his business only through the context blocks and the tools - both come from his real records.

TOOLS: Read tools query his real records - use them whenever a question needs specifics beyond the context blocks (a load, a total, a contact, a past message). Write tools record things in his books. Every figure you state must come from a context block, a tool result, or the owner's own message - never estimate, never fill a gap with a plausible number. If a tool reports an error, tell him that lookup failed instead of covering for it.

WRITES: If he directly tells you to record something ("log fuel $120 at Pilot"), call the write tool with confirmation "execute" and then confirm back what was actually recorded. If YOU think something should be recorded but he didn't ask, call it with confirmation "propose" - it will not be recorded unless he replies yes, and your message must say so plainly.

FULL COVERAGE: You have read and write tools for every tab of his app - loads, expenses, fuel purchases, brokers, customers, drivers, trucks (including the profile and the appliance inventory), trailers, pre-trip inspections, equipment checklist items, maintenance events and schedules, duty logs, documents, memories, dispatch history, and BOTH briefing engines (the industry-intelligence engine's daily briefings AND the Deep Research engine's briefings below). get_document reads a document's actual extracted text when the document has been scanned. If he asks about any part of the business, look it up with the tools - never tell him you can't see a part of the app, and never answer from a guess when a tool can check.

RESEARCH: Two different engines brief him, and they are not interchangeable - always name which one an answer came from. The INDUSTRY-INTELLIGENCE engine writes a daily summary (list_industry_briefings). The DEEP RESEARCH engine watches fuel, markets, law, and weather and writes full reports with findings and a counter-move (list_research_briefings, get_research_briefing for the full text). When he asks what the research found, check both and label each part. When he asks you to look into a new topic, queue it with queue_research - it runs on the engine's next tick under its caps, not instantly, and you must say so. Pre-trip photo asks from the Deep Research engine may be waiting (list_research_requests): when one is outstanding and the moment fits - he's doing a pre-trip or about to roll on that load - ask him for those photos in the conversation, with the ask's reason. Don't raise it in every message, and if he says skip it, dismiss it with dismiss_research_request. When his photos arrive they are filed by photo intake, which clears the ask - never claim you received photos you haven't seen filed.

DELETES: delete_record always stages a proposal, even when he orders the delete directly. Tell him it is staged and needs his yes on the proposal - never say a delete is done until a proposal resolves.

DUMPS: When one message carries several recordable facts at once (a forwarded dispatch thread, a pasted rate con or settlement, a brain-dump paragraph), extract ALL of them and call stage_dump_items ONCE with every item - not the individual write tools one by one, and never with confirmation "execute" for dump content. Each item needs a source_quote copied verbatim from his message, and an honest confidence. Leave unknown fields out entirely - never guess a rate, a date, a gate code, or an id; ids for updates come from the read tools, called BEFORE staging when an item touches an existing record. Code rejects any item whose numbers don't appear in his message; the tool result names the rejections - relay them plainly and don't re-stage a rejected value.

CORRECTIONS: When a numbered dump batch is pending (the context block lists it) and he corrects an item ("3 is wrong, it's 4417"), call revise_pending_item with confirmation "execute" - that edits the stored proposal only; it still is not recorded until he approves. Never re-stage a whole dump for a correction, and never execute a batch item yourself - approvals are resolved outside you, in code.

HOS: The duty-log tool data is the paper-log helper, never the ELD and never legal advice - keep the §6 framing when HOS comes up: helper numbers are a cross-check against the ELD, and the ELD governs.

MAINTENANCE: Three different things - do not blur them. An EVENT is work already done (create_maintenance_event); a SCHEDULE is recurring future work (create_maintenance_schedule / complete_maintenance_schedule); a DEFECT is an observed problem being tracked (create_vehicle_defect / resolve_vehicle_defect). When he reports work done, pass template_key on the event when it matches the standard library (engine_oil, fuel_filters, chassis_lube, brake_inspection, air_filter, tire_inspection, coolant_test, belt_hose_inspect, dot_annual, dpf_service, trans_diff_fluid) - code pairs the schedule's completion into the same proposal, so his one yes records the work AND advances the schedule; never stage the completion yourself alongside the event. For "what's due / how's the truck looking", call maintenance_outlook - one answer, including open defects - instead of assembling lists. When a truck is new or he asks what he should be tracking, call propose_maintenance_pack. A FAILED pre-trip's defects get staged as defect proposals in code after the inspection records - tell him they're staged for his yes, don't stage duplicates yourself. A defect closes only when he approves its closure (resolve_vehicle_defect); "the carrier's problem, stop asking" means propose status dismissed - dismissal is permanent. The library's intervals are typical manufacturer/fleet starting points - say so when you present them; they are not the carrier's figures and not the truck manual's.

MEMORY: If he dictates a durable fact in conversation (not a standing instruction - those come through his "instruction:" messages), save it with the save_memory tool. If the turn's JSON-free chat ends and you proposed nothing, just answer. The REMEMBERED FACTS block is a budget-limited slice of a much bigger store (the CONTEXT REPORT says how big) - when he refers to something that isn't in the block, use search_memory to look it up across all memories, past messages, and documents before saying you don't have it. Never claim a fact is gone just because it isn't in this turn's block.

JOB COACHING: He is new to over-the-road work and learning the job from inside it. When he asks how to handle something - a document, a dock problem, a message he has to answer - coach him from the JOB KNOWLEDGE below: the exact steps, what to check before he signs anything, what to photograph, and the words to say. Ground it in his actual situation (his load and clocks from the context and tools), never generic filler.

ROUTE CHECKS: When he asks whether he can make a load, when he needs to leave, or forwards a load he wants planned, run check_route on the RECORDED load (its id from list_loads) and report the verdict plainly — ON TIME / EARLY / LATE / NOT LEGAL, the leave-by, and the rests it inserts. The check reads the route, his clocks, and his truck from his records; never estimate a drive time or a distance yourself. If the load isn't recorded yet, say so and get it recorded first (a dump proposal he approves, or his direct order) — a check on an unrecorded load doesn't exist. A photo he sends is filed as a document automatically before you see the turn; if he asks what a photo said, read it back with get_document / search_documents.

PAY: Never do pay math in your head and never grade an offer from vibes. When pay comes up - an offer, a load's worth, "what should I ask for" - get the structure first (per-mile loaded-only or all-miles, percentage of gross or net, or flat; W2 or 1099; who pays fuel), then call evaluate_pay_offer and report its verdict and its questions plainly. If his carrier (or anyone) asks HIM what he wants to be paid and the structure isn't settled yet, the right move is asking the structure questions first - coach him to that, with the exact wording, instead of blurting a number.

PAY TRUTH (the pin): The PAY PIN block in your context is his pay structure as his records establish it. If it says PINNED, argue from it. If it says NOT PINNED, you must NEVER state one pay model as his - not "he's on percentage", not "at his rate" - present the candidate models side by side (get_pay_status computes which ones a settlement actually fits) and coach him to pin it down (what he gets told, or one settlement's math). WHAT HE WILL BE PAID: for "what will I make on this load / this week / by payday" call projected_pay (code-computed from his pay terms - cents per mile and/or a percent of the load - or the figure he set on a load) and relay its numbers and notes; never do pay arithmetic yourself. If he states what a load pays him ("this one pays me 1,250"), propose update_load with pay_dollars; to change his terms (rate, percent, pay week, payday) propose set_pay_terms. The tools: get_pay_status (pin + latest settlement truth), extract_settlement (structure a settlement document's text into a draft), record_settlement (record a settlement - propose unless he ordered it), set_pay_pin (pin the structure - from his words it can execute on his order; from a settlement's math it is always a proposal), weekly_pay_report (the code-computed weekly truth), explain_load_pay (one load's money walk, lesson-style). SETTLEMENT FLOW: when a settlement photo or text arrives (photo -> document, then extract_settlement; pasted text -> assemble the record from it), extract it, call record_settlement with the lines EXACTLY as printed - code then checks the math against the pin and computes his true pay (tax set-aside, spendable, $/mile, $/hour); report a PIN MISMATCH plainly when code finds one (both figures, never absorbed), and if the settlement's math fits a model better than the pin, propose the corrected pin with the fit shown. BOL and rate-con photos are NOT settlements - don't settle-record them.

THREADS & OPEN LOOPS: A forwarded or pasted work conversation is a THREAD, not a blob. On Telegram, forwards are auto-recorded as thread records during the dispatch workup; on any surface, when he pastes a conversation in chat, reconstruct it and record it with record_forward_thread (propose unless he ordered it): participants with roles, messages VERBATIM (never translate or clean up a body - §11; tag each message's own language), the ask, who it's of, the deadline, and whether it's still unanswered. Follow-ups from the same conversation append to the same thread in code - record the new segment the same way and let the matcher do its job. "What's hanging / waiting on me?" is answered from list_open_threads and the OPEN LOOPS block - records, not recollection; if a conversation was never forwarded, say it isn't tracked rather than reconstructing from vibes. When he says he answered an ask (or a later forward shows his reply), close the loop with mark_thread_answered.

PEOPLE MODELS: Beyond single facts, you build a MODEL of each person from his accumulated forwards - who they are, their role, what he communicates with them for. build_person_model shows the evidence and its CONFIDENCE (computed from counts in code): quote it at exactly that strength - "thin" means say it's thin. propose_person_model stages the model as their profile labeled UNCONFIRMED (provenance model_inferred_unconfirmed); it only becomes confirmed when he approves/corrects it. Never state an unconfirmed model as fact, never invent a detail to round a person out, and when there's no evidence, say there's no evidence.

LIFE PHASE: The LIFE PHASE block is the seat he's in - frame advice for it (the lease-on learning seat now; his own truck and authority later). If he tells you the phase changed ("I bought the truck"), that's a "Life phase" business_fact to propose saving - the block follows his word from then on.

VOICE & THE TWIN: Voice notes arrive already transcribed into text (marked [voice] in the timeline) - work them exactly like typed messages. The DRIVER TWIN learns how he writes from what he ACTUALLY sends: when he shows you a reply he sent (pastes it, forwards the thread, tells you the words), capture it with record_sent_reply against its exchange (list_recent_exchanges finds the id) - code measures how far his words sit from your draft, and that number is the twin's report card, quoted honestly via twin_status. "What do I usually do when...?" is answered ONLY from decision_patterns - counts from his logged decisions, or "not enough history yet"; never invent a pattern. Log his real load decisions (taken/passed + outcomes) with record_load_decision when he states them. If the twin is off, these tools say so - relay it plainly, don't work around it.

PEOPLE & BUSINESS LEARNING: You are learning his business and the people in it. When a conversation or a forwarded thread shows something durable about a person he works with (the owner, a dispatcher, a broker, a shipper) or about how his operation runs (how this carrier pays, a facility's rules), propose it with save_memory - kind "person_profile" in the tool's PERSON format, or "business_fact" in its BUSINESS format - with confirmation "propose", so he approves what you learned before it sticks. One current profile per person: when you learn more, propose the whole updated line. Profiles and business facts come back to you in the REMEMBERED FACTS block - use them ("the carrier usually settles Fridays") instead of treating every message like it's from a stranger. Never invent a profile detail to fill a gap.

${JOB_KNOWLEDGE_BRIEF}`;

/** Pay safety (owner 2026-11-07: telling Abel he doesn't pay for fuel zeroed his pay). */
const PAY_SAFETY_RULES =
  "PAY SAFETY: telling you WHO PAYS for fuel or tolls changes ONLY that one field (fuel_paid_by / tolls_paid_by) - never send a rate, a percent, miles or any money value with it, and never set a rate, miles or pay to 0 unless he says that number in so many words. " +
  "set_pay_pin and set_pay_terms keep every field you do not name. Before proposing a pay change, read his current terms (get_pay_status / projected_pay) and say what CHANGES, before and after. " +
  "Never ask him to approve the same thing twice: if something is already waiting for his yes, tell him it is waiting instead of proposing it again.";

/** Temporal reasoning (owner 2026-11-07): dates and durations come from code, and old state is labelled as old. */
const TEMPORAL_RULES =
  "TIME: never work out a weekday, a relative date ('next Friday', 'in 3 weeks', 'the 6th') or a count of days in your head - call when_is / time_between, and say the resolved calendar date back to him when it matters, naming which reading you used if the tool flags one. " +
  "The NOW line is the current moment on his clock. Things go stale: a load's 'active' state, an ETA, a memory about 'this week' are true AS OF when they were recorded - check their dates against NOW and say 'as of Tuesday' instead of asserting old state as current. Keep events in order and say what happened before or after what.";

export type ConfirmationKind = "yes" | "no" | "other";

// A BARE confirmation is one of these short phrases and NOTHING else (telegram audit 2026-11-06, P0-1):
// "No that's not it. Delete that" or "Yes but make it $3,100" carry a new request or a correction, so
// they are never resolved as a plain yes/no - the leading-"No" path cancels and hands the rest to the
// model, and a "Yes, but..." goes to the model with the proposal in context (it is NOT executed as-is).
const YES_WORDS = new Set([
  "yes", "yeah", "yep", "yup", "do it", "go ahead", "confirm", "confirmed",
  "sí", "si", "dale", "yes do it", "yes please", "yes sir", "yes go ahead", "yes confirm", "yeah do it", "yep do it",
]);
/** Acknowledgements that are only a yes in a narrow case (fresh, non-destructive proposal) - P1-10. */
const SOFT_YES_WORDS = new Set(["ok", "okay", "sure", "k", "kk", "alright", "all right"]);
const NO_WORDS = new Set([
  "no", "nope", "nah", "cancel", "drop it", "don't", "dont", "never mind",
  "nevermind", "forget it", "no thanks", "no thank you", "don't do it", "dont do it", "no don't", "no dont",
]);

function normalizeConfirmation(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s.!,]+$/u, "")
    .replace(/\s*[👍✅👌🙏]+$/u, "")
    .replace(/\s+/g, " ");
}

export function classifyConfirmation(text: string): ConfirmationKind {
  const normalized = normalizeConfirmation(text);
  if (YES_WORDS.has(normalized)) return "yes";
  if (NO_WORDS.has(normalized)) return "no";
  return "other";
}

/** "ok" / "sure" alone: a yes only for a proposal shown just now that is not a delete (P1-10). */
export function isSoftYes(text: string): boolean {
  return SOFT_YES_WORDS.has(normalizeConfirmation(text));
}

/** A message that STARTS with yes but carries more ("yes but make it 3100"): never an approval as-is. */
export function isYesWithMore(text: string): boolean {
  return classifyConfirmation(text) === "other" && /^(yes|yeah|yep|yup|sí|si)\b[\s,.!:-]+\S/i.test(text.trim());
}

/**
 * Why a stored proposal failed, for P0-2: a PERMANENT failure (the record does not exist, the value is
 * refused) can never succeed by retrying, so it is dropped and said plainly; only a TRANSIENT failure
 * (the database or network hiccupped) keeps the proposal for a retry.
 */
export function isPermanentWriteFailure(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { name?: string }).name === "ZodError") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/fetch failed|network|timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|socket|503|502|504|temporarily|rate limit/i.test(msg)) return false;
  return /\bno \w[\w ]* with id\b|not found|does not exist|doesn't exist|invalid|must be|required|violates|refused|not allowed|can't|cannot|already|uuid/i.test(msg);
}

/**
 * The code-assembled context for a conversational turn (reused by
 * both surfaces). Lane 2 (Intelligence Upgrade Phase A, design
 * §3.5): assembly is budget-based hybrid retrieval now - standing
 * instructions load in FULL from their own query (never filtered
 * out of a newest-100 window again), facts come from hybrid
 * retrieval over ALL current facts with a mandatory self-report
 * line, history is 12 verbatim turns plus the rolling weekly
 * summary for anything older. The v1 load-100-and-keyword-pick
 * path is gone from context assembly.
 */
export async function loadBotContext(
  store: BotBrainStore,
  userText: string,
): Promise<Omit<BotChatInput, "userText">> {
  const [history, snapshot, instructions, retrieval, summary, payPin, lifePhaseOverride, openLoops, activeEmployer] = await Promise.all([
    store.loadConversationHistory(12),
    store.loadSnapshot(),
    store.loadInstructionMemories(),
    store.retrieveFacts(userText),
    store.loadLatestSummary(),
    // Phase D: the pay pin rides every context (design §3.5 / §5) -
    // pinned, Abel argues from it; un-pinned, the block says so and
    // Abel must not invent a structure.
    store.loadPayPin(),
    // Phase C: life-phase framing + open loops ride along too -
    // assembled in code from the same records, never model-elected.
    store.loadLifePhaseOverride(),
    store.listThreads({ openOnly: true, unansweredOnly: true, limit: 3 }),
    store.loadActiveEmployer ? store.loadActiveEmployer() : Promise.resolve(null),
  ]);
  return {
    history,
    snapshotText: snapshot ? formatCompanySnapshot(snapshot) : null,
    instructions: instructions as BotChatInput["instructions"],
    memories: retrieval.facts as BotChatInput["memories"],
    memoryReport: retrieval.reportLine,
    summaryText: summary
      ? `EARLIER CONVERSATION SUMMARY (week of ${summary.weekStart} - built from his actual past turns, which remain stored in full):\n${summary.summary}`
      : null,
    payPinText: formatPayPinLine(payPin),
    lifePhaseText: buildLifePhaseText(payPin, lifePhaseOverride, activeEmployer),
    openLoopsText: formatOpenLoopsBlock(openLoops),
  };
}

function proposalSuffix(summaries: string[]): string {
  const lines = summaries.map((s) => `- ${s}`).join("\n");
  return `\n\n⏳ I have NOT recorded this yet:\n${lines}\n\n👉 Reply YES to confirm, or NO to drop it.`;
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
    return { reply: `✅ Done - ${result.charAt(0).toLowerCase()}${result.slice(1)}\n${savedWhere(pending.tool_name)}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    // P0-2 (telegram audit 2026-11-06): a permanent failure ("No load with id ...") can never succeed on a
    // retry. Keeping it made it the newest proposal again, so every later YES hit the same dead item and
    // starved everything else. It is dropped, and he is told what to do instead.
    if (isPermanentWriteFailure(err)) {
      return {
        reply:
          `That couldn't be recorded (${detail}), so I dropped it - nothing was saved: ${pending.summary}. ` +
          "Tell me again what you want and I'll look up the right record first.",
      };
    }
    // Transient (database/network): put the proposal back WITH its original time, so it keeps its place
    // in line and its 2-hour expiry, and doesn't jump ahead of what he saw last.
    let kept = false;
    try {
      await store.savePendingAction({ toolName: pending.tool_name, args: pending.arguments, summary: pending.summary, createdAt: pending.created_at });
      kept = true;
    } catch (restageErr) {
      console.error("[bot] could not re-stage a failed proposal:", restageErr);
    }
    return {
      reply: kept
        ? `I couldn't record it just now (${detail}) - that looks like a connection problem, not a problem with the entry. Nothing was saved and I've kept it: ${pending.summary}. Reply YES to try again, or NO to drop it.`
        : `I tried to record it and it failed (${detail}). Nothing was saved: ${pending.summary}. Tell me how you'd like to fix it and I'll try again.`,
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
      lines.push(`✅ ${item.item_number ?? ""}. ${result}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      lines.push(
        `❌ ${item.item_number ?? ""}. ${item.summary} — FAILED (${detail}). Nothing was saved for this one.`,
      );
    }
  }
  const wheres = [...new Set(items.map((i) => savedWhere(i.tool_name)))];
  return `${lines.join("\n")}\n\n${wheres.join("\n")}`;
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

/**
 * R-6 (Research Intelligence design D-5): the ask side of the
 * pre-trip photo contract. Pending research_requests are surfaced
 * as a context block so Abel raises them in conversation when the
 * moment fits. Read failures (including the table not existing
 * before migration 00040 lands) never break a turn - the block is
 * simply absent, exactly like the pre-migration fallbacks elsewhere.
 */
async function loadPendingResearchAskBlock(store: BotBrainStore): Promise<string | null> {
  try {
    const pending = await listPendingResearchRequests(store.client, store.companyId, 3);
    if (pending.length === 0) return null;
    const lines: string[] = [];
    for (const request of pending) {
      let loadLabel = "";
      if (request.load_id) {
        loadLabel = ` for load ${request.load_id}`;
        try {
          const { data } = await store.client
            .from("loads")
            .select("origin, destination")
            .eq("company_id", store.companyId)
            .eq("id", request.load_id)
            .maybeSingle();
          if (data) {
            const load = data as { origin: string; destination: string };
            loadLabel = ` for his ${load.origin} → ${load.destination} load`;
          }
        } catch {
          // The id alone still grounds the ask; a label lookup must
          // never take the block down with it.
        }
      }
      const reason = requestReason(request);
      lines.push(
        `- [${request.id}] photograph: ${requestPhotoItems(request).join(", ")}${loadLabel}${reason ? ` - why: ${reason}` : ""}`,
      );
    }
    return (
      "OUTSTANDING PRE-TRIP PHOTO ASKS (from the Deep Research engine - it governs when you ask; R-6):\n" +
      lines.join("\n") +
      "\nIf the moment fits (he's doing his pre-trip or about to roll), ask him for these photos once, with the reason. Don't raise them in every message. If he says skip it, call dismiss_research_request. Matching pre-trip photos filed through Abel mark the ask fulfilled (the photo must match the ask's load and cover everything it asked for) - you never mark it fulfilled yourself."
    );
  } catch {
    return null;
  }
}

/**
 * P0-5: after a YES/NO resolves the newest proposal, anything else still open is named - so the next
 * bare YES is never a surprise, and nothing waiting is forgotten.
 */
async function withStillWaiting(store: BotBrainStore, out: BotChatOutput, excludeKey?: string | null): Promise<BotChatOutput> {
  try {
    const open = (await store.loadOpenPendingGroups()).filter(
      (g) =>
        g.toolName !== PHOTO_PURPOSE_TOOL &&
        g.key !== excludeKey &&
        // already named in this very reply (a kept-for-retry proposal) - never listed twice
        !out.reply.includes(g.summary) &&
        Date.now() - new Date(g.createdAt).getTime() <= PENDING_EXPIRY_MS,
    );
    if (open.length === 0) return out;
    const lines = open.map((g) => `- ${g.summary}`).join("\n");
    const next = open.length === 1 ? "👉 Reply YES to record it too, or NO to drop it." : "👉 Tell me which one you mean, in your own words.";
    return { ...out, reply: `${out.reply}\n\n⏳ Still waiting for your yes/no:\n${lines}\n${next}` };
  } catch {
    return out;
  }
}

/** P1-2: the current moment on his clock, for every turn. */
export function nowBlock(now: Date): string {
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  const isoDay = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return `NOW: ${text} Eastern (America/New_York) - today is ${isoDay}. Resolve "an hour ago", "today", "yesterday", "the 6th" from this; dates you record are on this clock.`;
}

/** P1-3: documents filed in the last few hours (newest first), so "that image / it's the BOL" has an id. */
async function loadRecentDocumentsBlock(store: BotBrainStore): Promise<string | null> {
  try {
    const since = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const { data, error } = await store.client
      .from("documents")
      .select("id, file_name, related_entity_type, related_entity_id, created_at")
      .eq("company_id", store.companyId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5);
    if (error || !data || data.length === 0) return null;
    const rows = data as { id: string; file_name: string; related_entity_type: string; related_entity_id: string; created_at: string }[];
    const when = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
    const lines = rows.map(
      (d) =>
        `- [${d.id}] "${d.file_name}" at ${when(d.created_at)} ET - ${d.related_entity_type === "company" ? "NOT attached to anything yet" : `attached to ${d.related_entity_type} ${d.related_entity_id}`}`,
    );
    return (
      "RECENT PHOTOS / DOCUMENTS HE SENT (newest first; ids are real):\n" +
      lines.join("\n") +
      "\nWhen he says \"that's the BOL\", \"this goes with that\", \"that image\", he means the newest one unless he says otherwise: attach it with attach_document to the load he means (list_loads for its id). Never change a load's status to attach a photo."
    );
  } catch {
    return null;
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
  // §9: a pending dump batch has its own grammar (approve all /
  // by number / drop the rest), resolved the same way.
  // Expired proposals are dropped silently so a pile of stale memory
  // prompts can never answer (or hijack) a new request. The one exception:
  // if the ONLY thing waiting is an expired proposal and he answers
  // yes/no, the newest one is kept so he is told it expired.
  {
    const cutoff = new Date(Date.now() - PENDING_EXPIRY_MS).toISOString();
    const groups = (await store.loadOpenPendingGroups()).filter((g) => g.toolName !== PHOTO_PURPOSE_TOOL);
    const live = groups.filter((g) => g.createdAt >= cutoff);
    const expired = groups.filter((g) => g.createdAt < cutoff);
    if (expired.length > 0) {
      const bare = classifyConfirmation(input.userText) !== "other" || parseBatchCommand(input.userText).kind !== "other";
      const newestExpired = expired[expired.length - 1]!;
      await store.dropExpiredPending(cutoff, live.length === 0 && bare ? newestExpired.key : null);
    }
  }
  const pending = await store.loadPendingAction();
  // Trip 1234 audit (P1): a bare yes/no targets what was most recently
  // shown. If several proposals are open and the newest was NOT shown
  // just now, a bare answer could mean any of them - list them, ask.
  if (pending && pending.tool_name !== PHOTO_PURPOSE_TOOL) {
    const bare =
      classifyConfirmation(input.userText) !== "other" || isSoftYes(input.userText) || parseBatchCommand(input.userText).kind !== "other";
    if (bare && Date.now() - new Date(pending.created_at).getTime() > SHOWN_RECENTLY_MS) {
      const open = (await store.loadOpenPendingGroups()).filter(
        (g) => g.toolName !== PHOTO_PURPOSE_TOOL && Date.now() - new Date(g.createdAt).getTime() <= PENDING_EXPIRY_MS,
      );
      if (open.length > 1) {
        return {
          reply:
            `I have ${open.length} things waiting and I'm not sure which one you mean, so I haven't done any of them:\n` +
            open.map((g, i) => `${i + 1}. ${g.summary}`).join("\n") +
            "\nTell me which one you mean, in your own words, and I will handle just that one.",
        };
      }
    }
  }
  let pendingBatch: PendingAction[] = [];
  // Image Intelligence (§3.3): the oldest pending row may be a
  // photo-purpose QUESTION, not a write proposal. It resolves in
  // code when his reply names the answer (a number, a purpose
  // word, a plain naming); an expired question resolves with the
  // honest expiry reply. Anything else leaves it open - noted in
  // the context blocks below - and the turn proceeds normally.
  let pendingPhotoAsk: PendingAction | null = null;
  let cancelledSuggestion: string | null = null;
  // P0-1: "yes but make it 3100" - the waiting proposal is NOT executed; a corrected proposal replaces it.
  let correctingPending: PendingAction | null = null;
  if (pending?.tool_name === PHOTO_PURPOSE_TOOL) {
    const resolved = await tryResolvePhotoPurposeAsk(store, pending, input.userText);
    if (resolved) return resolved;
    pendingPhotoAsk = pending;
  } else if (pending?.batch_id) {
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
        return withStillWaiting(store, await resolveBatch(store, pendingBatch, command), pendingBatch[0]?.batch_id);
      }
      // "other" (typically a correction) falls through to the model
      // with the batch in context - see the context block below.
    }
  } else if (pending) {
    const kind = classifyConfirmation(input.userText);
    if (kind !== "other") {
      return withStillWaiting(store, await resolvePending(store, pending, kind));
    }
    // P1-10: "ok" / "sure" is a yes only for a proposal he saw just now that isn't a delete; otherwise ask.
    if (isSoftYes(input.userText)) {
      const fresh = Date.now() - new Date(pending.created_at).getTime() <= SHOWN_RECENTLY_MS;
      if (fresh && pending.tool_name !== "delete_record") return withStillWaiting(store, await resolvePending(store, pending, "yes"));
      return {
        reply: `Just to be sure - do you want me to record this? ${pending.summary}\nReply YES to record it, or NO to drop it.`,
      };
    }
    if (isYesWithMore(input.userText)) correctingPending = pending;
    // "No. Remove that. Add this..." - a leading no answers the waiting
    // proposal (it is cancelled, in code) and the rest of the message is a
    // NEW request. The cancel can never become a delete of a saved record.
    if (/^no\b[.,!]?\s+\S/i.test(input.userText.trim())) {
      await store.clearPendingAction(pending.id);
      cancelledSuggestion = pending.summary;
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
  // P1-2: the agent had no clock - "an hour ago", "today", "the 6th" were guesses.
  contextBlocks.push(nowBlock(new Date()));
  // P1-3: "that's the BOL / that image" - the photos he just sent, by id, so they can be attached.
  const photosBlock = await loadRecentDocumentsBlock(store);
  if (photosBlock) contextBlocks.push(photosBlock);
  if (input.instructions.length > 0) {
    contextBlocks.push(`STANDING INSTRUCTIONS FROM THE OWNER:\n${input.instructions.map((i) => `- ${i}`).join("\n")}`);
  }
  if (pendingPhotoAsk) {
    const askArgs = pendingPhotoAsk.arguments as unknown as PhotoPurposeAskArgs;
    contextBlocks.push(
      `A PHOTO IS WAITING FOR ITS PURPOSE (the question expires after 2 hours): ${pendingPhotoAsk.summary}. Candidate purposes: ${(askArgs.candidates ?? []).map((c) => c.purpose).join(", ") || "none recorded"}, or just file it as a plain document. The purpose settles only when he taps a button, replies with the option number, or names it plainly ("that's the trailer") - code handles those before you see them, so if you are reading this, this message did none of those. Answer him normally; do not claim the photo was filed under a purpose, and do not stage a write for the photo.`,
    );
  } else if (pendingBatch.length > 0) {
    contextBlocks.push(
      `A DUMP BATCH IS WAITING FOR HIS APPROVAL (item numbers are stable; batches expire after 2 hours):\n${pendingBatch.map(batchItemLine).join("\n")}\n` +
        "Approvals and drops are handled in code before you ever see them, so this message is NOT an approval. If he is correcting an item, use revise_pending_item (confirmation \"execute\") and confirm the corrected line back. Do not execute any batch item yourself and do not re-stage the dump.",
    );
  } else if (pending) {
    contextBlocks.push(
      `A PROPOSED ACTION IS WAITING FOR HIS YES/NO (over 2 hours old proposals expire): ${pending.summary}. If he says yes or no, it is handled - anything else, answer normally and it stays waiting.`,
    );
  }
  if (correctingPending) {
    contextBlocks.push(
      `HE ANSWERED THE WAITING PROPOSAL WITH "YES" PLUS MORE: "${input.userText}". This is NOT an approval and nothing was recorded. If he is correcting it, propose the corrected version with the same tool (it replaces the waiting one). If he approves it as-is and also asks something else, answer the something else and tell him to reply a plain YES to record: ${correctingPending.summary}`,
    );
  }
  if (cancelledSuggestion) {
    contextBlocks.push(
      `HE JUST SAID NO to your waiting suggestion, and it is cancelled (nothing was recorded): ${cancelledSuggestion}. The rest of his message is a NEW request - handle it fresh and do not carry the cancelled item into it. The cancel itself is never a delete; only if he explicitly asks to delete a SAVED record, find it with a read tool and propose delete_record for that record.`,
    );
  }
  const researchAskBlock = await loadPendingResearchAskBlock(store);
  if (researchAskBlock) contextBlocks.push(researchAskBlock);
  if (input.summaryText) contextBlocks.push(input.summaryText);
  // Phase C: the life-phase framing (which seat he's in, what this
  // phase is for) precedes the money blocks it frames.
  if (input.lifePhaseText) contextBlocks.push(input.lifePhaseText);
  // Phase D: the pay pin block rides every agent turn (pinned or
  // the explicit NOT-PINNED instruction - see formatPayPinLine).
  if (input.payPinText) contextBlocks.push(input.payPinText);
  // Phase C: open loops, when any recorded thread has an ask still
  // hanging - grounded before he has to ask.
  if (input.openLoopsText) contextBlocks.push(input.openLoopsText);
  if (input.snapshotText) contextBlocks.push(input.snapshotText);
  if (input.memories.length > 0) {
    contextBlocks.push(
      `REMEMBERED FACTS ABOUT HIM AND HIS BUSINESS:\n${input.memories.map((m) => `- ${m.content}`).join("\n")}`,
    );
  }
  if (input.memoryReport) {
    // Self-reporting truncation (design §3.5): the model SEES the
    // budget line, so "how much do you remember?" gets an honest
    // answer and a held-back fact is a search away, not a silence.
    contextBlocks.push(`CONTEXT REPORT: ${input.memoryReport}`);
  }

  const botTools = gateExecutes(buildBotTools(store), input.userText);
  const result = await runAgentLoop({
    provider,
    system: `${AGENT_SYSTEM_PROMPT}\n\n${PAY_SAFETY_RULES}\n\n${TEMPORAL_RULES}\n\n${STYLE_RULES}\n\n${FLAIR_RULES}`,
    contextText: contextBlocks.join("\n\n"),
    history: input.history,
    userText: input.userText,
    tools: botTools,
    onToolLog: hooks.onToolLog,
  });

  let reply = result.reply;
  // §5.4 pairing (Image Intelligence): a staged maintenance event
  // pulls its schedule completion into the same batch, in code -
  // recording the work and advancing the schedule take ONE yes.
  // Pairing failure never costs him the event proposal itself.
  // P1-6: after a cancel, a delete stands only when his own words ask for one ("No. Delete that log entry");
  // it used to drop every delete silently, including the one he asked for.
  const askedToDelete = /\b(delete|remove|erase|get rid of|take (it|that) off)\b/i.test(input.userText);
  let proposals = cancelledSuggestion && !askedToDelete
    ? result.proposals.filter((p) => p.tool !== "delete_record")
    : result.proposals;
  if (proposals.some((p) => p.tool === "create_maintenance_event")) {
    try {
      proposals = await expandMaintenancePairings(store, proposals);
    } catch (err) {
      console.error("[bot] maintenance pairing failed:", err);
    }
  }
  // §7.6 correction discipline (Image Intelligence): a delete
  // aimed at a paper-sourced duty row carries the re-mark-your-
  // paper line in its proposal text - the app's mirror can
  // change, the paper can't, and his yes must know that.
  if (proposals.some((p) => p.tool === "delete_record")) {
    try {
      proposals = await annotatePaperLogEdits(store, proposals);
    } catch (err) {
      console.error("[bot] paper-log edit annotation failed:", err);
    }
  }
  if (correctingPending && proposals.some((p) => p.tool === correctingPending!.tool_name)) {
    await store.clearPendingAction(correctingPending.id);
  }
  // No redundant approvals (owner 2026-11-07): reconcile with what is already waiting and within this turn.
  let reconcileNotes: string[] = [];
  let alreadyWaiting: string[] = [];
  if (proposals.length > 0) {
    try {
      const waiting = (await store.loadOpenPendingRows()).filter((w) => w.tool_name !== PHOTO_PURPOSE_TOOL);
      const rec = reconcileProposals(proposals, waiting);
      for (const p of rec.stage) {
        if (!rec.mergedTools.includes(p.tool)) continue;
        // two changes to one thing were merged: the summary must describe the MERGED change
        const tool = botTools.find((t) => t.name === p.tool);
        try {
          const verdict = await tool?.verifyProposal?.(p.args);
          p.summary = verdict && verdict.ok && verdict.summary ? verdict.summary : tool?.summarize ? tool.summarize(p.args) : p.summary;
        } catch {
          /* keep the later summary */
        }
      }
      if (rec.clearIds.length > 0) await store.clearPendingActions(rec.clearIds);
      proposals = rec.stage;
      reconcileNotes = rec.notes;
      alreadyWaiting = rec.alreadyWaiting;
    } catch (err) {
      console.error("[bot] proposal reconcile failed (staging as proposed):", err);
    }
  }
  if (proposals.length > 0) {
    // §9: dump items arrive as proposals sharing a batch id - they
    // are stored with stable item numbers and shown as ONE
    // consolidated numbered list; plain §8 proposals keep their
    // existing single-proposal path.
    // P0-4 (telegram audit 2026-11-06): two separate proposals each said "reply YES", but one YES only ever
    // answers one of them. More than one single in a turn becomes ONE numbered list instead, answered with
    // the batch grammar (yes = all, "1 and 3", "drop the rest").
    // A delete stays its own proposal (saved first, so the list is what a YES answers and the delete is named
    // as still waiting): one casual YES must never also delete something.
    const looseSingles = proposals.filter((p) => !p.batchId && p.tool !== "delete_record");
    if (looseSingles.length > 1) {
      const batchId = randomUUID();
      proposals = proposals.map((p) => (p.batchId || p.tool === "delete_record" ? p : { ...p, batchId }));
    }
    const singles = proposals.filter((p) => !p.batchId);
    const batches = new Map<string, typeof proposals>();
    for (const proposal of proposals) {
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
      // P2-1: the appended block is the only "reply YES" he sees - the model's own copy is dropped.
      reply = stripConfirmationProse(reply) + suffixes.join("");
    } else {
      reply = `${RAN_OUT_OF_STEPS_REPLY}\n\nWhat I did line up before running out:${suffixes.join("")}`;
    }
  }

  if (reconcileNotes.length > 0) {
    reply += `\n\n🔁 ${reconcileNotes.join("\n🔁 ")}`;
    if (proposals.length === 0 && alreadyWaiting.length > 0) {
      reply = `${stripConfirmationProse(reply)}\n\n⏳ Waiting for your yes:\n${alreadyWaiting.map((s) => `- ${s}`).join("\n")}\n\n👉 Reply YES to confirm, or NO to drop it.`;
    }
  }
  // A "reply YES" with nothing staged (the proposal was refused or never made) would answer nothing - or,
  // worse, something older. It is dropped unless a proposal really is waiting.
  if (proposals.length === 0 && /\breply\s+(?:with\s+)?["“']?yes\b/i.test(reply)) {
    const waiting = await store.loadPendingAction().catch(() => null);
    if (!waiting) {
      reply = stripConfirmationProse(reply) || "I haven't recorded anything yet - tell me what you'd like and I'll set it up.";
    }
  }
  return { reply };
}
