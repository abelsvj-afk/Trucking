// Telegram audit 2026-11-06 (P0-6): whether a write may EXECUTE on the model's say-so is no longer the
// model's call alone for the tools that went wrong live. "Just completed the load" made it log a load
// decision and close a thread nobody mentioned. For these tools, an execute stands only when the owner's
// own message names that kind of action; otherwise the call is turned into a PROPOSAL he approves.
// (Deletes and dump staging are always proposals already - agent-loop `alwaysPropose`.)

import type { AgentTool } from "@/services/ai/agent-loop";

export const NAMED_ACTION_PATTERNS: Record<string, RegExp> = {
  mark_thread_answered: /\b(answer(ed)?|repl(y|ied)|responded|told (him|her|them)|close (the |that )?thread|done with (that|the|this) (thread|conversation))\b/i,
  record_load_decision: /\b(took|taking|accepted|accept(ing)?|passed( on)?|pass on|declined?|turned (it |that )?down|said no to|booked|rejected?)\b/i,
  attach_document: /\b(attach|goes with|go with|put (it|this|that) (on|with)|file (it|this|that) (under|with)|that'?s the (bol|receipt|rate ?con|paperwork|pod))\b/i,
  update_load: /\b(change|update|set|fix|correct|should (say|be|read)|make it|move|mark|complete[ds]?|delivered|cancel(led)?|confirm(ed)?|was late|rate is|miles)\b/i,
  complete_load: /\b(complete[ds]?|delivered|dropped (it|the load|the trailer) off|finished|done with (the|that|this) load|unloaded|empty now)\b/i,
  draft_email_reply: /\b(draft|write|compose|prepare|put together|start)\b.{0,40}\b(repl(y|ies)|response|email|e-mail|message|back)\b|\b(repl(y|ies)|respond)\b.{0,30}\b(to|for)\b/i,
  // send_email is alwaysPropose already, so the gate never changes it; the pattern documents the
  // send-intent wording the deterministic staging in agent-turn.ts recognises ("send it", "send the reply").
  send_email: /^\s*(please\s+)?send\b|\bsend\s+(it|that|this|the\s+(e-?mail|reply|draft|message))\b|\bgo\s+ahead\s+and\s+send\b/i,
  revise_email_draft: /\b(change|edit|revise|rewrite|reword|update|tweak|shorten|lengthen|add|remove|replace|make it|instead|softer|firmer|friendlier)\b/i,
  record_forward_thread: /\b(record|save|log|keep) (this|that|the) (thread|conversation|chat)\b/i,
};

/** The turn's tools, with an execute turned into a proposal for any gated tool his message does not name. */
export function gateExecutes(tools: AgentTool[], userText: string): AgentTool[] {
  return tools.map((tool) => {
    const pattern = NAMED_ACTION_PATTERNS[tool.name];
    if (!pattern || tool.alwaysPropose || pattern.test(userText)) return tool;
    return { ...tool, alwaysPropose: true };
  });
}
