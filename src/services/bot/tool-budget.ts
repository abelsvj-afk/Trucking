// The model API accepts at most 128 tools per request (OpenAI's hard limit). The registry grew past it (131 at last count), so
// EVERY message was rejected and Abel went silent. The registry itself is untouched - writes run from the full set after a yes -
// but each TURN offers the model a bounded selection:
//   * every WRITE tool stays (a proposal must always be possible, and a pending yes resolves by code, not by this list);
//   * every read tool whose name or description matches what he just said stays;
//   * the remaining read tools fill the budget in registry order (the most general ones were registered first).
// Deterministic, no model call, and it never returns more than the budget. A test pins "the full registry is selectable under the
// limit" so the next tool added cannot silently take Abel down again.
//
// Dynamic selection (owner requirement, 2026-11-09): the per-turn cap must never make a needed capability unreachable - Abel
// "can have thousands of tools, it just needs to know which ones it needs in this moment." Selection is therefore only the
// FIRST step: the agent loop also carries the full registry as a catalog and offers a find_more_tools search over it, so a
// tool the router did not pick can be pulled into the SAME turn on demand (see agent-loop.ts). Selection scales with the
// registry because it ranks by the words in his message against tool names/descriptions - and if the WRITE tools alone ever
// outgrow the budget, they are ranked the same way instead of offered wholesale, with find_more_tools covering the rest.

import type { AgentTool } from "@/services/ai/agent-loop";

export const PROVIDER_TOOL_LIMIT = 128;
/** Headroom under the hard limit (the loop may add control specs; a small margin is cheap, a rejected message is not). */
export const TOOL_BUDGET = 120;

const STOP = new Set(["the", "and", "for", "with", "that", "this", "what", "when", "where", "how", "did", "does", "can", "you", "his", "her", "are", "was", "any", "all", "get", "show", "list", "give", "tell", "about", "have", "from", "into", "out", "now", "just", "please"]);

const words = (text: string): string[] => (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));

/** How well a tool matches a set of content words: exact name-part hits weigh most, description hits keep long-tail tools findable. */
function scoreTool(tool: AgentTool, said: Set<string>): number {
  const nameParts = tool.name.toLowerCase().split("_");
  const descWords = tool.description.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  let s = 0;
  for (const w of said) {
    if (nameParts.some((p) => p === w || (w.length > 4 && p.startsWith(w.slice(0, 5))))) s += 3;
    // Description matching is word-based with the same prefix rule as names: "watching" must find
    // a tool described with "watchers", and "learned" one described with "learning" - substring
    // matching missed both, and the miss cost a headline research tool its place in the selection.
    else if (descWords.some((d) => d === w || (w.length > 4 && d.startsWith(w.slice(0, 5))))) s += 1;
  }
  return s;
}

/** Ranked slice of `tools` by match score against `text` (ties keep registry order). Score-0 tools are included only when `fill` is set. */
function rankTools(tools: AgentTool[], text: string, count: number, fill: boolean): AgentTool[] {
  const said = new Set(words(text));
  return tools
    .map((tool, index) => ({ tool, index, score: scoreTool(tool, said) }))
    .filter((r) => fill || r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, count))
    .map((r) => r.tool);
}

/**
 * Search the FULL registry by intent words - the retrieval step behind the loop's find_more_tools. Returns only real
 * matches (score > 0), best first, so a capability that exists is findable by what it DOES, not just its exact name.
 * This is what keeps selection honest as the registry grows toward thousands: nothing is reachable ONLY by being
 * in the router's first pick.
 */
export function searchToolCatalog(tools: AgentTool[], query: string, limit = 10): AgentTool[] {
  return rankTools(tools, query, limit, false);
}

export function selectToolsForTurn(tools: AgentTool[], userText: string, budget: number = TOOL_BUDGET): AgentTool[] {
  if (tools.length <= budget) return tools;
  const nonReads = tools.filter((t) => t.access !== "read");
  const reads = tools.filter((t) => t.access === "read");
  const keep = new Set<AgentTool>();
  if (nonReads.length < budget) {
    // Today's shape: every write stays offered (a proposal is always possible); reads are ranked by what he said
    // and fill the remaining room, score-0 reads included in registry order so general tools stay reachable.
    for (const t of nonReads) keep.add(t);
    for (const t of rankTools(reads, userText, budget - keep.size, true)) keep.add(t);
  } else {
    // Scale shape (registry far past the cap): writes are ranked by intent too. A slice of the budget is reserved
    // for matching reads; anything not picked is still one find_more_tools call away inside the same turn.
    const readSlots = Math.min(reads.length, Math.max(8, Math.floor(budget * 0.15)));
    for (const t of rankTools(reads, userText, readSlots, true)) keep.add(t);
    for (const t of rankTools(nonReads, userText, budget - keep.size, true)) keep.add(t);
  }
  // Preserve the registry order the prompt was written against.
  return tools.filter((t) => keep.has(t));
}
