// The model API accepts at most 128 tools per request (OpenAI's hard limit). The registry grew past it (131 at last count), so
// EVERY message was rejected and Abel went silent. The registry itself is untouched - writes run from the full set after a yes -
// but each TURN offers the model a bounded selection:
//   * every WRITE tool stays (a proposal must always be possible, and a pending yes resolves by code, not by this list);
//   * every read tool whose name or description matches what he just said stays;
//   * the remaining read tools fill the budget in registry order (the most general ones were registered first).
// Deterministic, no model call, and it never returns more than the budget. A test pins "the full registry is selectable under the
// limit" so the next tool added cannot silently take Abel down again.

import type { AgentTool } from "@/services/ai/agent-loop";

export const PROVIDER_TOOL_LIMIT = 128;
/** Headroom under the hard limit (the loop may add control specs; a small margin is cheap, a rejected message is not). */
export const TOOL_BUDGET = 120;

const STOP = new Set(["the", "and", "for", "with", "that", "this", "what", "when", "where", "how", "did", "does", "can", "you", "his", "her", "are", "was", "any", "all", "get", "show", "list", "give", "tell", "about", "have", "from", "into", "out", "now", "just", "please"]);

const words = (text: string): string[] => (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));

export function selectToolsForTurn(tools: AgentTool[], userText: string, budget: number = TOOL_BUDGET): AgentTool[] {
  if (tools.length <= budget) return tools;
  const keep = new Set<AgentTool>(tools.filter((t) => t.access !== "read"));
  const reads = tools.filter((t) => t.access === "read");
  const room = Math.max(0, budget - keep.size);
  const said = new Set(words(userText));
  const score = (t: AgentTool) => {
    const nameParts = t.name.toLowerCase().split("_");
    let s = 0;
    for (const w of said) {
      if (nameParts.some((p) => p === w || (w.length > 4 && p.startsWith(w.slice(0, 5))))) s += 3;
      else if (t.description.toLowerCase().includes(w)) s += 1;
    }
    return s;
  };
  const ranked = reads
    .map((tool, index) => ({ tool, index, score: score(tool) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, room);
  for (const { tool } of ranked) keep.add(tool);
  // Preserve the registry order the prompt was written against.
  return tools.filter((t) => keep.has(t));
}
