// Everyday asks answered from his records in CODE (docs/design/abel-do-what-i-ask.md section 2, owner 2026-11-16).
// For a recognized question the matching read tool runs BEFORE the model, and its result rides the context as
// fact - the model still words the answer, but it can no longer skip the lookup, guess, or say "pending".
// Read-only. A failed read just leaves the model its tools, as before.

import type { AgentTool } from "@/services/ai/agent-loop";

interface GroundedAsk {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  matches: (t: string) => boolean;
}

const ASKS: GroundedAsk[] = [
  {
    label: "HIS HOURS RIGHT NOW (from his duty log - planning only, not an ELD)",
    tool: "hos_summary",
    args: {},
    matches: (t) =>
      /\b(how many|how much|what('?s| are)?)\b.*\b(hours|drive time|driving time|clock|clocks|on my 14|on my 11|on my 70|recap)\b/.test(t) ||
      /\b(my hours|hours left|time left|can i (still )?drive)\b/.test(t),
  },
  {
    label: "HIS LOADS IN CALENDAR ORDER (from his records)",
    tool: "load_calendar",
    args: { days: 21 },
    matches: (t) => /\b(next|upcoming|current|my) (load|trip|pickup|delivery)\b|\bwhere am i (going|headed)\b|\bwhat('?s| is) (my )?next\b/.test(t),
  },
  {
    label: "HIS PAY THIS MONTH AND HIS MONTHLY GOAL (docs/design/monthly-income-goal.md)",
    tool: "monthly_income",
    args: {},
    matches: (t) =>
      /\b(this|the) month\b.*\b(make|made|pay|earn|income)\b|\b(make|made|earn|income)\b.*\b(this|the) month\b/.test(t) ||
      /\b(my|the) goal\b|\bgo(ing)? home\b.*\b(enough|money|goal)\b|\benough\b.*\bgo home\b/.test(t),
  },
  {
    label: "SMART PATH FOR HIS CURRENT RUN, planned from his live position, next stop and hours (docs/design/smart-path-v2.md)",
    tool: "plan_my_run",
    args: {},
    matches: (t) =>
      /\b(plan my (run|trip|route|day)|will i make it|am i (going to|gonna) make it|when (will|do|would) i (get there|arrive|deliver)|where (should|do) i (sleep|park|fuel|stop))\b/.test(t),
  },
];

/** Which grounded asks this message is (often none). Long messages are left to the model. */
export function groundedAsksFor(text: string): GroundedAsk[] {
  const t = text.toLowerCase().trim();
  if (t.length > 160) return [];
  return ASKS.filter((a) => a.matches(t));
}

/** The facts for this message, as context blocks. Never throws. */
export async function groundedAskBlocks(text: string, tools: AgentTool[]): Promise<string[]> {
  const blocks: string[] = [];
  for (const ask of groundedAsksFor(text)) {
    const tool = tools.find((t) => t.name === ask.tool && t.access === "read");
    if (!tool) continue;
    try {
      const result = await tool.run(ask.args);
      blocks.push(`${ask.label} - looked up in code just now; answer his question from this:\n${String(result)}`);
    } catch (err) {
      console.error(`[bot] grounded ask ${ask.tool} failed (the model keeps the tool)`, err);
    }
  }
  return blocks;
}
