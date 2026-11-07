// learning_report: how his answers to Abel's proposals have gone (owner approved 2026-11-07; design section 6).
// Read-only; computed in code from the outcome log (migration 00076).

import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { learningReport, readyLessons, summarizeOutcomes } from "./learning";

export function buildLearningTools(store: BotBrainStore): AgentTool[] {
  return [
    {
      name: "learning_report",
      description:
        "How he has answered your suggestions over the last 90 days - approved vs turned down, per kind of suggestion - and which lessons have earned a proposal. Computed in code from his real answers. Use for 'what have you learned', 'what do I usually say no to', or before changing how often you suggest something.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const [outcomes, remembered] = await Promise.all([store.loadRecentOutcomes(), store.loadMemories().catch(() => [])]);
        const stats = summarizeOutcomes(outcomes, new Date());
        return learningReport(stats, readyLessons(stats, remembered.map((m) => m.content)));
      },
    },
  ];
}
