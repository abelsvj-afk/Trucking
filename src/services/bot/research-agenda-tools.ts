// Autonomous Research tools (docs/design/autonomous-research.md
// §§3-5): Abel's conversational side of the standing watch, the
// durable knowledge layer, and the self-directed learning agenda.
//
// Read tools answer from research_knowledge / research_learning_topics
// WITH source, Eastern date, and a freshness label computed in code -
// and say plainly when the picture is thin or stale instead of
// letting an answer guess. Write tools keep the propose→yes
// discipline exactly: propose_learning_topic is staged like every
// write (his yes IS the approval, and execution queues the run);
// approve/dismiss act on agenda rows the tick filed as proposals.
//
// On a database where migration 00084 has not landed yet, the reads
// degrade to one honest sentence instead of an error - the same
// graceful-absence pattern the memory store uses for 00032.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import { researchNowSchema } from "@/data/schemas/research";
import {
  easternShortDate,
  isWatchTopic,
  knowledgeFreshness,
  WATCH_TOPIC_DEFS,
  WATCH_TOPICS,
  type WatchTopic,
} from "@/lib/watch-topics";
import type { BotBrainStore } from "./store";
import { insertRow, validateWith } from "./tool-helpers";

type Row = Record<string, unknown>;

const NOT_LANDED =
  "The autonomous-research layer isn't switched on in the database yet (migration 00084 hasn't been applied), so there's no stored watch picture to read. The Deep Research engine itself still works - list_research_briefings has what it found.";

function isMissingTableError(error: { message?: string } | null): boolean {
  if (!error?.message) return false;
  return (
    /research_knowledge|research_learning_topics/.test(error.message) &&
    /does not exist|could not find/i.test(error.message)
  );
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface KnowledgeRow extends Row {
  watch_topic: string;
  title: string;
  content: string;
  source_title: string | null;
  source_url: string | null;
  observed_at: string;
}

const KNOWLEDGE_SELECT = "watch_topic, title, content, source_title, source_url, observed_at";

export function buildResearchAgendaTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;
  const tools: AgentTool[] = [
    {
      name: "list_watch_topics",
      description:
        "What Abel is standing watch over for him, and how fresh each picture is: his business (from his own records), the trucking industry, crypto awareness (BTC/XRP - awareness only), his path to his own truck + authority, and his build plan. Each topic comes with why it's watched and the freshness of the newest stored fact. Use when he asks what you're watching/keeping an eye on, or before answering from the stored picture.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const { data, error } = await client
          .from("research_knowledge")
          .select(KNOWLEDGE_SELECT)
          .eq("company_id", companyId)
          .order("observed_at", { ascending: false })
          .limit(100);
        if (error) {
          if (isMissingTableError(error)) return NOT_LANDED;
          throw new Error(error.message);
        }
        const rows = (data ?? []) as KnowledgeRow[];
        const latest = new Map<string, KnowledgeRow>();
        for (const row of rows) {
          if (!latest.has(row.watch_topic)) latest.set(row.watch_topic, row);
        }
        const now = new Date();
        const lines = ["What I'm standing watch over (standing watch topics, newest stored fact per topic):"];
        for (const key of WATCH_TOPICS) {
          const def = WATCH_TOPIC_DEFS[key];
          const row = latest.get(key);
          const fresh = knowledgeFreshness(key, row?.observed_at ?? null, now);
          lines.push(`- ${def.label} [${key}] - ${fresh.label}. Why: ${def.why}`);
          if (row) lines.push(`  Latest: ${row.title} (${easternShortDate(row.observed_at)})`);
        }
        return lines.join("\n");
      },
    },
    {
      name: "get_knowledge",
      description:
        "Search Abel's stored research knowledge (distilled from the watchers and his own records) by standing topic and/or keywords. Every result carries its source and date plus a freshness label - relay the label in your answer: a stale fact is background, never a current claim, and when this says the picture is thin, say that instead of guessing. Crypto results are market awareness only - never present them as trading advice, and they never touch his loans.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: [...WATCH_TOPICS],
            description: "Optional standing watch topic to read (own_business, industry, crypto, authority_pathways, build_plan).",
          },
          query: { type: "string", description: "Optional keywords to match against stored knowledge." },
          limit: { type: "number", description: "How many entries, 1-10. Default 5." },
        },
      },
      access: "read",
      async run(args) {
        const limit = Math.min(10, Math.max(1, typeof args.limit === "number" ? args.limit : 5));
        let query = client
          .from("research_knowledge")
          .select(KNOWLEDGE_SELECT)
          .eq("company_id", companyId)
          .order("observed_at", { ascending: false })
          .limit(30);
        if (typeof args.topic === "string" && isWatchTopic(args.topic)) {
          query = query.eq("watch_topic", args.topic);
        }
        const { data, error } = await query;
        if (error) {
          if (isMissingTableError(error)) return NOT_LANDED;
          throw new Error(error.message);
        }
        let rows = (data ?? []) as KnowledgeRow[];
        const needle = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
        if (needle) {
          const words = needle.split(/\s+/).filter((w) => w.length >= 3);
          if (words.length > 0) {
            rows = rows.filter((r) =>
              words.some((w) => `${r.title} ${r.content}`.toLowerCase().includes(w)),
            );
          }
        }
        rows = rows.slice(0, limit);
        if (rows.length === 0) {
          return (
            "Stored knowledge: nothing on file for that yet - the picture is THIN here. " +
            "Say so plainly instead of guessing; if it matters, propose a learning topic (propose_learning_topic) or queue research (queue_research)."
          );
        }
        const now = new Date();
        const lines = ["Stored knowledge (source + date on every line - quote the freshness, don't upgrade it):"];
        for (const row of rows) {
          const topic = isWatchTopic(row.watch_topic) ? row.watch_topic : null;
          const fresh = topic ? knowledgeFreshness(topic, row.observed_at, now) : null;
          const source = row.source_title
            ? `source: ${row.source_title}${row.source_url ? ` (${row.source_url})` : ""}`
            : "source: his own records";
          lines.push(
            `- [${row.watch_topic}] ${row.title} - ${row.content} (${source}; ${easternShortDate(row.observed_at)}${fresh ? `; ${fresh.label}` : ""})`,
          );
        }
        return lines.join("\n");
      },
    },
    {
      name: "list_learning_topics",
      description:
        "Abel's self-directed learning agenda: research topics Abel has PROPOSED (from watching his knowledge go dark or stale) and ones already approved and queued. Each carries the reason in plain words. Use when he asks what you want to look into, what's on your learning list, or before proposing a duplicate.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const { data, error } = await client
          .from("research_learning_topics")
          .select("id, topic, reason, watch_topic, status, created_at")
          .eq("company_id", companyId)
          .in("status", ["proposed", "queued"])
          .order("created_at", { ascending: false })
          .limit(10);
        if (error) {
          if (isMissingTableError(error)) return NOT_LANDED;
          throw new Error(error.message);
        }
        const rows = (data ?? []) as Row[];
        if (rows.length === 0) return "The learning agenda is empty - no proposed or queued research topics right now.";
        const lines = ["Learning agenda (his yes runs a topic; research is read-only learning):"];
        for (const row of rows) {
          lines.push(
            `- [${row.id}] (${row.status}${row.watch_topic ? `, ${row.watch_topic}` : ""}) ${row.topic}${str(row.reason) ? ` - why: ${row.reason}` : ""}`,
          );
        }
        return lines.join("\n");
      },
    },
  ];

  const proposeBot = z.object({
    topic: z.string().trim().min(3).max(200),
    reason: z.string().trim().min(1).max(500),
    watch_topic: z.enum(WATCH_TOPICS).optional(),
  });

  async function queueRunForTopic(topicText: string, reason: string, learningTopicId: string | null): Promise<string> {
    researchNowSchema.parse({ topic: topicText });
    return insertRow(client, "research_runs", companyId, {
      trigger_kind: "manual",
      topic: topicText,
      trigger_detail: {
        reason,
        ...(learningTopicId ? { learning_topic_id: learningTopicId } : {}),
      },
      status: "queued",
    });
  }

  tools.push({
    name: "propose_learning_topic",
    description:
      "Propose a research topic Abel noticed a gap on (his question exposed missing/stale knowledge, a watched topic has nothing behind it). Staged for his yes like every write: on approval it queues a Deep Research run under the engine's caps and records the topic on the learning agenda. Research is read-only learning - it never changes records or moves money. Say in your message what the gap is and why this topic fills it.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The research topic, in plain words (3-200 characters)." },
        reason: { type: "string", description: "The gap this fills and why it matters to him, in plain words." },
        watch_topic: {
          type: "string",
          enum: [...WATCH_TOPICS],
          description: "Optional standing watch topic the gap belongs to.",
        },
      },
      required: ["topic", "reason"],
    },
    access: "write",
    validateArgs: validateWith(proposeBot),
    summarize: (args) =>
      `Queue Deep Research on "${String(args.topic ?? "")}" (learning agenda) - ${String(args.reason ?? "")}`,
    async run(args) {
      const parsed = proposeBot.parse(args);
      const topicId = await insertRow(client, "research_learning_topics", companyId, {
        topic: parsed.topic,
        reason: parsed.reason,
        watch_topic: parsed.watch_topic ?? null,
        proposed_by: "abel",
        status: "proposed",
      });
      const runId = await queueRunForTopic(parsed.topic, parsed.reason, topicId);
      const { error } = await client
        .from("research_learning_topics")
        .update({ status: "queued", research_run_id: runId, decided_at: new Date().toISOString() })
        .eq("company_id", companyId)
        .eq("id", topicId);
      if (error) throw new Error(error.message);
      return (
        `Approved and queued: Deep Research on "${parsed.topic}" (run id ${runId}, learning topic ${topicId}). ` +
        "The engine runs it on its next tick under its normal caps; the briefing lands in list_research_briefings and the Research page."
      );
    },
  });

  const decideBot = z.object({ id: z.string().uuid() });

  tools.push({
    name: "approve_learning_topic",
    description:
      "Approve one PROPOSED learning-agenda topic (id from list_learning_topics): queues its Deep Research run under the engine's caps and marks it queued. This is the owner's yes on a topic Abel proposed - only call it when he approves that topic.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The learning topic id from list_learning_topics." } },
      required: ["id"],
    },
    access: "write",
    validateArgs: validateWith(decideBot),
    summarize: (args) => `Approve learning topic ${String(args.id ?? "")} and queue its research run`,
    async run(args) {
      const parsed = decideBot.parse(args);
      const { data, error } = await client
        .from("research_learning_topics")
        .select("id, topic, reason, status")
        .eq("company_id", companyId)
        .eq("id", parsed.id)
        .maybeSingle();
      if (error) {
        if (isMissingTableError(error)) return NOT_LANDED;
        throw new Error(error.message);
      }
      const row = data as Row | null;
      if (!row) return `No learning topic with id ${parsed.id} on the agenda.`;
      if (row.status !== "proposed") return `That learning topic is already ${String(row.status)} - nothing to approve.`;
      const runId = await queueRunForTopic(String(row.topic), str(row.reason) ?? "Owner approved Abel's proposed learning topic.", parsed.id);
      const { error: updateError } = await client
        .from("research_learning_topics")
        .update({ status: "queued", research_run_id: runId, decided_at: new Date().toISOString() })
        .eq("company_id", companyId)
        .eq("id", parsed.id)
        .eq("status", "proposed");
      if (updateError) throw new Error(updateError.message);
      return (
        `Approved and queued: Deep Research on "${String(row.topic)}" (run id ${runId}). ` +
        "It runs on the engine's next tick under its normal caps; the briefing lands in list_research_briefings and the Research page."
      );
    },
  });

  tools.push({
    name: "dismiss_learning_topic",
    description:
      "Dismiss one PROPOSED learning-agenda topic (id from list_learning_topics) - he said no, or not now. The topic is marked dismissed and Abel stops proposing that gap until the picture changes. Only call it when he declines the topic.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The learning topic id from list_learning_topics." } },
      required: ["id"],
    },
    access: "write",
    validateArgs: validateWith(decideBot),
    summarize: (args) => `Dismiss learning topic ${String(args.id ?? "")}`,
    async run(args) {
      const parsed = decideBot.parse(args);
      const { data, error } = await client
        .from("research_learning_topics")
        .update({ status: "dismissed", decided_at: new Date().toISOString() })
        .eq("company_id", companyId)
        .eq("id", parsed.id)
        .eq("status", "proposed")
        .select("id");
      if (error) {
        if (isMissingTableError(error)) return NOT_LANDED;
        throw new Error(error.message);
      }
      if ((data ?? []).length === 0) return "That learning topic wasn't in proposed state - nothing was dismissed.";
      return "Dismissed - that learning topic is off the agenda.";
    },
  });

  return tools;
}
