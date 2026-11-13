// Frontier 2 (Remember better) — the agent-episodes tools.
// Inventory decision (plan: "likely 2 new tools ... or extensions
// of the existing memory tools"): the existing memory tools
// (list_memories / search_memory / save_memory) read and write
// bot_memories only, and their kinds, lifecycle, and prompts are
// built around that table. Extending save_memory to also write
// agent_episodes would blur two stores with different shapes
// (episodes carry kind/situation/lesson/valence/confidence).
// Three dedicated tools instead:
// - list_agent_lessons (read): what Abel has learned, with ids.
// - save_agent_lesson (write): saves a learned lesson — the tool
//   consolidation stages, and the model calls when a lesson has
//   earned saving. Always a proposal unless he ordered it.
// - correct_agent_lesson (write): his correction of a lesson —
//   superseding row at confidence 1.0, provenance owner_stated.
// Registry: 148 -> 151 (measured on this branch; see the
// assembly pin in agent-turn.test.ts).

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { validateWith } from "./tool-helpers";

const saveLessonArgs = z.object({
  summary: z.string().min(1).max(300),
  lesson: z.string().min(1).max(2000),
  situation: z.string().max(2000).optional(),
  valence: z.enum(["helped", "hurt", "neutral"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const correctLessonArgs = z.object({
  episode_id: z.string().uuid(),
  lesson: z.string().min(1).max(2000),
});

export function buildEpisodeTools(store: BotBrainStore): AgentTool[] {
  return [
    {
      name: "list_agent_lessons",
      description:
        "List the lessons Abel has learned about working with him — current agent episodes, newest first, WITH ids and the evidence behind each. Use when he asks what you've learned, what you know about him, or before correcting a lesson (find it here, then call correct_agent_lesson with its id). Optional query filters by words in the lesson.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      access: "read",
      async run(args) {
        const query = String(args.query ?? "").trim().toLowerCase();
        const rows = await store.listEpisodes({ limit: 200 });
        const hits = rows.filter(
          (e) => !query || `${e.summary} ${e.lesson ?? ""}`.toLowerCase().includes(query),
        ).slice(0, 25);
        if (hits.length === 0) return query ? `No lesson mentions "${query}".` : "No lessons learned yet.";
        return hits
          .map(
            (e) =>
              `- [${e.id}] (${e.kind}${e.valence ? `, ${e.valence}` : ""}) ${e.lesson ?? e.summary}` +
              `${e.situation ? ` — evidence: ${e.situation}` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "save_agent_lesson",
      description:
        "Save a lesson Abel learned about working with him (kind \"learned\") — from a clear pattern in his answers, or a correction that taught something durable. This is how a learned lesson gets recorded; consolidation stages it the same way. A lesson quoting a superseded figure is refused by the synthesis guard — never save a lesson with a dollar figure you have not re-checked.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Short title for the lesson." },
          lesson: { type: "string", description: "The lesson itself, in plain words." },
          situation: { type: "string", description: "What happened — the evidence behind the lesson." },
          valence: { type: "string", enum: ["helped", "hurt", "neutral"] },
          confidence: { type: "number", description: "0..1 confidence in the lesson." },
        },
        required: ["summary", "lesson"],
      },
      access: "write",
      validateArgs: validateWith(saveLessonArgs),
      summarize(args) {
        const parsed = saveLessonArgs.parse(args);
        return `Lesson learned: "${parsed.lesson}"`;
      },
      async run(args) {
        const parsed = saveLessonArgs.parse(args);
        const id = await store.saveEpisode({
          kind: "learned",
          summary: parsed.summary,
          situation: parsed.situation ?? null,
          lesson: parsed.lesson,
          valence: parsed.valence ?? null,
          confidence: parsed.confidence ?? 0.8,
          provenance: "model_inferred_unconfirmed",
        });
        if (!id) throw new Error("The lesson couldn't be saved yet - migration 00092 hasn't been applied to the database.");
        return `Saved lesson: "${parsed.lesson}".`;
      },
    },
    {
      name: "correct_agent_lesson",
      description:
        "Correct a lesson Abel learned — saves the corrected lesson as a NEW row at max confidence (provenance: his word) and closes the old one, so the history of what he used to believe stays queryable. Use with the lesson's id from list_agent_lessons.",
      parameters: {
        type: "object",
        properties: {
          episode_id: { type: "string", description: "The lesson's id from list_agent_lessons." },
          lesson: { type: "string", description: "The corrected lesson, in plain words." },
        },
        required: ["episode_id", "lesson"],
      },
      access: "write",
      validateArgs: validateWith(correctLessonArgs),
      summarize(args) {
        const parsed = correctLessonArgs.parse(args);
        return `Correct a learned lesson to: "${parsed.lesson}"`;
      },
      async run(args) {
        const parsed = correctLessonArgs.parse(args);
        await store.correctEpisode(parsed.episode_id, parsed.lesson);
        return `Corrected the lesson to: "${parsed.lesson}". The old wording stays in history.`;
      },
    },
  ];
}
