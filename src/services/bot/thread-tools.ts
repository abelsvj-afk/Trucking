// Abel Intelligence Upgrade, Phase C (design §4 + the owner's
// per-person learning scope). The thread and people tools: forward
// reconstructions become stored records, open loops become
// answerable, and per-person models are built from accumulated
// evidence - in code, with counts - and staged, never asserted.
//
// Write discipline matches the rest of the brain: recordable
// content stages through propose->yes (the agent loop's
// confirmation), and a person model is saved ONLY as a
// person_profile with provenance "model_inferred_unconfirmed" -
// retrievable context treats unconfirmed inferences as unconfirmed
// (design §3.2), and his correction supersedes like any profile.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { validateWith } from "./tool-helpers";
import { buildPersonModel } from "./threads";

const participantArgs = z.object({
  name: z.string().min(1),
  role: z.enum(["carrier_dispatch", "steven", "broker", "shipper", "receiver", "owner", "other"]),
});

const recordThreadArgs = z.object({
  title: z.string().min(1).optional(),
  participants: z.array(participantArgs).min(1).max(20),
  messages: z
    .array(
      z.object({
        sender: z.string().min(1),
        /** VERBATIM body - never translated, never rewritten (§11). */
        body: z.string().min(1),
        language: z.enum(["en", "es", "unknown"]).default("unknown"),
        sent_at: z.string().min(1).optional(),
      }),
    )
    .min(1)
    .max(200),
  the_ask: z.string().min(1).optional(),
  ask_of: z.string().min(1).optional(),
  deadline_text: z.string().min(1).optional(),
  unanswered: z.boolean().default(false),
  source: z.enum(["forward", "paste", "photo", "chat"]).default("forward"),
  exchange_id: z.string().uuid().optional(),
});

function threadHeadline(t: {
  title: string | null;
  participants: { name: string; role: string }[];
  theAsk: string | null;
  askOf: string | null;
  deadlineText: string | null;
  unanswered: boolean;
}): string {
  const who = t.participants.filter((p) => p.role !== "owner").map((p) => p.name).join(", ");
  return (
    `${t.title ?? `Thread with ${who || "unknown"}`}` +
    (t.theAsk ? ` — ask: ${t.theAsk}${t.askOf ? ` (of ${t.askOf})` : ""}` : " — no ask") +
    (t.deadlineText ? ` — deadline: ${t.deadlineText}` : "") +
    (t.unanswered ? " — UNANSWERED" : "")
  );
}

export function buildThreadTools(store: BotBrainStore): AgentTool[] {
  return [
    {
      name: "record_forward_thread",
      description:
        "Record a forwarded/pasted conversation as a stored THREAD (design §4): participants with roles, the messages VERBATIM (never translate a body - §11; tag each message's own language), the ask and who it's of, the deadline, and whether the ask is still unanswered. Code matches it to an existing open thread (same counterparty) and appends, or starts a new thread. Use this whenever he forwards or pastes a work conversation - the thread record is what 'anything hanging?' reads later. Stage with confirmation \"propose\" unless he ordered the recording directly.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          participants: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                role: { type: "string", enum: ["carrier_dispatch", "steven", "broker", "shipper", "receiver", "owner", "other"] },
              },
              required: ["name", "role"],
            },
          },
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sender: { type: "string" },
                body: { type: "string", description: "Verbatim - exactly as written in the conversation." },
                language: { type: "string", enum: ["en", "es", "unknown"] },
                sent_at: { type: "string" },
              },
              required: ["sender", "body"],
            },
          },
          the_ask: { type: "string" },
          ask_of: { type: "string" },
          deadline_text: { type: "string" },
          unanswered: { type: "boolean" },
          source: { type: "string", enum: ["forward", "paste", "photo", "chat"] },
          exchange_id: { type: "string", description: "The dispatch exchange this conversation produced, when known (voice-corpus link)." },
        },
        required: ["participants", "messages"],
      },
      access: "write",
      validateArgs: validateWith(recordThreadArgs),
      summarize(args) {
        const parsed = recordThreadArgs.parse(args);
        const who = parsed.participants.filter((p) => p.role !== "owner").map((p) => p.name).join(", ");
        return `Thread record: ${parsed.messages.length} message(s) with ${who || "unknown"}${parsed.the_ask ? ` — ask: ${parsed.the_ask}` : ""}${parsed.unanswered ? " (unanswered)" : ""}`;
      },
      async run(args) {
        const parsed = recordThreadArgs.parse(args);
        const recorded = await store.recordForwardThread({
          title: parsed.title ?? null,
          participants: parsed.participants,
          messages: parsed.messages.map((m) => ({
            senderName: m.sender,
            body: m.body,
            language: m.language,
            sentAt: m.sent_at ?? null,
          })),
          theAsk: parsed.the_ask ?? null,
          askOf: parsed.ask_of ?? null,
          deadlineText: parsed.deadline_text ?? null,
          unanswered: parsed.unanswered,
          source: parsed.source,
          exchangeId: parsed.exchange_id ?? null,
        });
        return recorded.appended
          ? `Appended ${recorded.messageCount} message(s) to the existing open thread (${recorded.threadId}) - same conversation, one record.`
          : `Recorded as a new thread (${recorded.threadId}) with ${recorded.messageCount} message(s).`;
      },
    },
    {
      name: "list_open_threads",
      description:
        "His open conversation threads and their open loops - call this for 'anything hanging?', 'what's waiting on me?', 'what did dispatch ask?'. Unanswered asks are flagged from the thread RECORDS, not from memory. unanswered_only narrows to just the open loops.",
      parameters: {
        type: "object",
        properties: { unanswered_only: { type: "boolean" } },
      },
      access: "read",
      async run(args) {
        const unansweredOnly = args.unanswered_only === true;
        const threads = await store.listThreads({ openOnly: true, unansweredOnly, limit: 20 });
        if (threads.length === 0) {
          return unansweredOnly
            ? "No open loops: no recorded thread has an unanswered ask right now. (Threads are recorded when he forwards conversations - if he hasn't forwarded it, it isn't tracked.)"
            : "No open threads recorded yet. Threads appear when he forwards a work conversation and it's recorded.";
        }
        return threads.map((t) => `- [${t.id}] ${threadHeadline(t)}`).join("\n");
      },
    },
    {
      name: "get_thread",
      description:
        "One thread's full record: participants, the ask, deadline, open-loop state, and the verbatim message timeline. Get the id from list_open_threads.",
      parameters: {
        type: "object",
        properties: { thread_id: { type: "string" } },
        required: ["thread_id"],
      },
      access: "read",
      async run(args) {
        const detail = await store.getThread(String(args.thread_id ?? ""));
        if (!detail) return "No thread with that id in his records.";
        const { thread, messages } = detail;
        const lines = [
          threadHeadline(thread),
          `Status: ${thread.status}. Language: ${thread.language ?? "unknown"}. Messages: ${messages.length}.`,
          ...messages.map((m) => `[${m.senderName}${m.language ? `/${m.language}` : ""}] ${m.body}`),
        ];
        return lines.join("\n");
      },
    },
    {
      name: "mark_thread_answered",
      description:
        "Close a thread's open loop: he answered the ask (he says so, or a later forward shows his reply). Sets the thread's unanswered flag off; the thread itself stays open for follow-ups. Use close=true only when the conversation itself is done (no more appends).",
      parameters: {
        type: "object",
        properties: {
          thread_id: { type: "string" },
          close: { type: "boolean", description: "Also close the thread (default false)." },
        },
        required: ["thread_id"],
      },
      access: "write",
      summarize(args) {
        return args.close === true ? "Close thread and its open loop" : "Mark thread's ask answered";
      },
      async run(args) {
        const threadId = String(args.thread_id ?? "");
        await store.markThreadAnswered(threadId);
        if (args.close === true) {
          await store.closeThread(threadId);
          return "Loop closed and thread closed - follow-ups will start a fresh thread.";
        }
        return "Marked answered - the open loop is closed; the thread stays open for follow-ups.";
      },
    },
    {
      name: "build_person_model",
      description:
        "What the accumulated evidence supports about one person (the per-person model): who they are and their role, what he communicates with them for, message/thread/exchange counts, and a CONFIDENCE label computed from the evidence - thin evidence says thin, and no evidence says none. Built from his forwarded threads + dispatch exchanges + any confirmed profile (his approved words outrank the model). Read-only: to SAVE the model as a profile, use propose_person_model (his yes required).",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The person's name as it appears in his forwards/profiles." } },
        required: ["name"],
      },
      access: "read",
      async run(args) {
        const name = String(args.name ?? "").trim();
        if (!name) throw new Error("build_person_model needs a name.");
        const evidence = await store.loadPersonEvidence(name);
        const model = buildPersonModel(name, evidence);
        return model.lines.join("\n");
      },
    },
    {
      name: "propose_person_model",
      description:
        "Stage Abel's evidence-based model of a person as their person_profile (propose->yes like every learned fact). The saved line is labeled as Abel's model with its confidence and evidence counts, stored with provenance model_inferred_unconfirmed - it is NEVER presented later as confirmed fact, and his correction replaces it. Refuses (honestly) when there is no evidence to model from.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      access: "write",
      validateArgs: validateWith(z.object({ name: z.string().min(1) })),
      summarize(args) {
        return `Person model proposal for ${String(args.name ?? "")} (from his forwarded threads + exchanges, labeled unconfirmed)`;
      },
      async run(args) {
        const name = String(args.name ?? "").trim();
        const evidence = await store.loadPersonEvidence(name);
        const model = buildPersonModel(name, evidence);
        if (!model.proposedProfileLine) {
          return `No evidence about ${name} in his forwards or exchanges yet - there is nothing honest to propose. Once he forwards a conversation with them, the model has something to stand on.`;
        }
        await store.saveMemory("person_profile", model.proposedProfileLine, {
          provenance: "model_inferred_unconfirmed",
        });
        return `Saved the model of ${model.name} as their profile, labeled unconfirmed (confidence: ${model.confidence}; evidence: ${model.threadCount} thread(s), ${model.messagesFromThem} message(s) from them, ${model.exchangeMentions} exchange mention(s)). It reads: ${model.proposedProfileLine}`;
      },
    },
  ];
}
