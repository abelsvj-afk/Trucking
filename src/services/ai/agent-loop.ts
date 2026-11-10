// Bot intelligence v2 (docs/design/driver-mvp.md §8). The bounded
// tool-calling loop behind the bot's conversational turns, shared by
// the Telegram bot and the web chat window.
//
// Rules that are enforced HERE, in code, not left to the prompt:
// - Bounded: at most MAX_AGENT_STEPS provider rounds. Exhaustion is
//   an honest "I ran out of steps" reply, never a fabricated answer.
// - Every tool call is logged (name, access, outcome) via onToolLog.
// - Write tools never execute on the model's say-so alone: a write
//   call is executed only when it carries confirmation: "execute"
//   (the owner's standing rule - that value is only legitimate when
//   the owner directly ordered the write in his message). Anything
//   else becomes a recorded proposal for the caller to store and
//   put to the owner for a yes; the loop itself stores nothing.
// - Grounding guard: dollar figures in the final reply must trace
//   to the grounding corpus (context blocks, the owner's own
//   message, or this turn's tool results). An untraceable figure
//   replaces the reply with an honest refusal to quote it.
// - Dynamic tool selection (owner requirement, 2026-11-09): the
//   per-turn tool list is a SELECTION from the full registry, never
//   the whole of what Abel can do. When the caller passes the full
//   registry as `toolCatalog`, the loop offers a find_more_tools
//   search over it: a capability the router did not pick can be
//   pulled into the SAME turn, and a call naming a real-but-unoffered
//   tool loads it instead of erroring. A routing absence must never
//   surface to the owner as "I can't do that."

import {
  isAgentCapableProvider,
  type AiAgentMessage,
  type AiProvider,
  type AiToolSpec,
} from "./provider";
import type { BotChatTurn } from "./bot-chat";
import { searchToolCatalog } from "@/services/bot/tool-budget";

/** The loop-provided search tool that pulls unoffered registry tools into the current turn. */
export const FIND_MORE_TOOLS_NAME = "find_more_tools";

export const BOT_CHAT_CAPABILITY = "bot_chat";

export const MAX_AGENT_STEPS = 6;

export const RAN_OUT_OF_STEPS_REPLY =
  "I ran out of steps on that one - I got partway through but didn't finish, so I won't guess at the rest. Try asking it in smaller pieces.";

export const UNGROUNDED_FIGURE_REPLY =
  "I almost quoted you a figure I can't trace back to your records, so I won't. Ask me again and I'll pull the exact numbers from your books first.";

export type ToolAccess = "read" | "write";

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's own arguments (without `confirmation` - the loop adds it for writes). */
  parameters: Record<string, unknown>;
  access: ToolAccess;
  /** Executes the tool against real data. Returns grounding text (real query output) for the model and the guard. */
  run: (args: Record<string, unknown>) => Promise<string>;
  /** One-line human summary of what a call would record - required for write tools (shown to the owner in a proposal). */
  summarize?: (args: Record<string, unknown>) => string;
  /**
   * Agent omnipresence (§9): this write NEVER executes inside the
   * loop, even when the owner directly orders it and the model
   * passes confirmation: "execute" - it is always staged as a
   * proposal for his explicit yes. Used by destructive tools
   * (delete_record) and by the dump staging tool (a dump is
   * agent-proposed by definition). Execution after his yes goes
   * through the caller's normal stored-proposal path, which calls
   * run() directly - the flag governs only the loop.
   */
  alwaysPropose?: boolean;
  /**
   * This write is REVERSIBLE and is itself only a staging step for a
   * later, separately-approved action (an email DRAFT: sending stays
   * behind send_email's own always-propose gate). When the execute
   * gate has established that the owner's own message names this
   * action, the loop runs it immediately even if the model passed
   * confirmation: "propose" - staging it as a proposal made the
   * owner's "draft a reply" take two yeses and left later turns with
   * no saved draft to send (live failure 2026-11-07: his YESes kept
   * executing the draft-SAVE instead of the send). The flag governs
   * only the loop; it never weakens the downstream approval gate.
   */
  immediateWhenNamed?: boolean;
  /**
   * Validates raw proposed arguments without executing (§9). Used
   * by dump staging to check an extracted item against the target
   * tool's own Zod schema before it is stored as a proposal.
   */
  validateArgs?: (
    args: Record<string, unknown>,
  ) => { ok: true; args: Record<string, unknown> } | { ok: false; error: string };
  /**
   * Telegram audit 2026-11-06 (P0-3): checks a proposal against his REAL records before it is shown
   * (the record it targets exists, in his company) and returns the summary in words - "DELETE load
   * Jacksonville -> Melbourne", not a uuid. A failure goes back to the model (so it looks the id up) and
   * nothing is staged: he is never asked to approve something that cannot happen.
   */
  verifyProposal?: (
    args: Record<string, unknown>,
  ) => Promise<{ ok: true; summary?: string } | { ok: false; error: string }>;
  /**
   * Turns one proposed call into several proposals (§9 dump
   * staging: one call carries every extracted item). Called only
   * on the proposal path. Rejected items come back with reasons
   * and are reported to the model - they are never stored.
   */
  expandProposals?: (
    args: Record<string, unknown>,
    ctx: { userText: string },
  ) => {
    proposals: ProposedWrite[];
    rejected: { summary: string; reason: string }[];
  };
}

export interface ProposedWrite {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  /** §9 dump batches: items expanded from one staging call share a batch id and carry their extraction evidence. */
  batchId?: string;
  sourceQuote?: string;
  confidence?: "high" | "medium" | "low";
}

export interface AgentToolLogEntry {
  tool: string;
  access: ToolAccess;
  outcome: "executed" | "proposed" | "error";
  detail?: string;
}

export interface AgentLoopInput {
  provider: AiProvider;
  system: string;
  /** Code-assembled context blocks (instructions, snapshot, memories) prepended to the owner's message. */
  contextText: string;
  history: BotChatTurn[];
  userText: string;
  tools: AgentTool[];
  /**
   * Dynamic selection: the FULL registry the turn's `tools` were selected from. When it contains
   * tools beyond the selection, the loop offers find_more_tools over it and auto-loads a tool the
   * model names but was not offered. Callers must pass the catalog in the same gated/filtered
   * shape as the selection (e.g. read-only turns pass a read-only catalog, so a pull can never
   * surface a write the turn refused).
   */
  toolCatalog?: AgentTool[];
  /** Hard cap on offered tool specs at any moment, the finder included (provider limit headroom). */
  toolSpecLimit?: number;
  maxSteps?: number;
  onToolLog?: (entry: AgentToolLogEntry) => void;
}

export interface AgentLoopOutput {
  reply: string;
  proposals: ProposedWrite[];
  toolLog: AgentToolLogEntry[];
  stepsUsed: number;
  ranOutOfSteps: boolean;
}

function specFor(tool: AgentTool): AiToolSpec {
  if (tool.access === "read") {
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  }
  const params = tool.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name: tool.name,
    description:
      tool.description +
      (tool.alwaysPropose
        ? ' This tool NEVER records anything immediately, even when the owner directly orders it: every call is staged as a proposal and takes effect only when he replies yes to it. Tell him that plainly.'
        : tool.immediateWhenNamed
          ? ' This tool only stages work for a later action the owner approves separately, so when he asks for it, it is done immediately - pass confirmation "execute". Nothing final is recorded by it.'
          : ' The "confirmation" argument is required: use "execute" ONLY when the owner directly told you in this message to record this (e.g. "log fuel $120 at Pilot"); use "propose" for anything you are suggesting yourself - a proposal is NOT recorded unless the owner replies yes.'),
    parameters: {
      ...tool.parameters,
      properties: {
        ...(params.properties ?? {}),
        confirmation: {
          type: "string",
          enum: ["execute", "propose"],
          description: "execute = the owner directly ordered this write in his message; propose = your own suggestion, awaiting his yes.",
        },
      },
      required: [...(params.required ?? []), "confirmation"],
    },
  };
}

const AMOUNT_PATTERN = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})?/g;

function amountsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const value = Number.parseFloat(`${match[1]!.replace(/,/g, "")}${match[2] ?? ""}`);
    if (Number.isFinite(value)) found.add(value.toFixed(2));
  }
  return found;
}

/** Dollar figures in `reply` that appear nowhere in the grounding corpus. */
export function ungroundedAmounts(reply: string, groundingCorpus: string): string[] {
  const grounded = amountsIn(groundingCorpus);
  return [...amountsIn(reply)].filter((amount) => !grounded.has(amount));
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopOutput> {
  if (!isAgentCapableProvider(input.provider)) {
    throw new Error("The configured AI provider does not support tool-calling turns.");
  }
  const provider = input.provider;
  const maxSteps = input.maxSteps ?? MAX_AGENT_STEPS;

  // --- Dynamic tool selection -------------------------------------
  // `offered` is what the model can call right now; it starts as the
  // caller's selection and can GROW mid-turn from the catalog. The
  // spec limit is never exceeded: making room evicts an offered READ
  // tool that has not been called yet this turn (never a write, never
  // the finder, never a tool already used) - and an evicted tool is
  // one find_more_tools call away from coming back.
  const catalog = input.toolCatalog ?? input.tools;
  const catalogByName = new Map(catalog.map((tool) => [tool.name, tool]));
  const specLimit = input.toolSpecLimit ?? 120;
  const pendingExpansions: AgentTool[] = [];
  const calledNames = new Set<string>();

  const finder: AgentTool | null =
    catalog.length > input.tools.length
      ? {
          name: FIND_MORE_TOOLS_NAME,
          description:
            "Search your FULL toolset for a capability this turn's tool list does not include, and load the matches for the rest of this turn. " +
            "Your list each turn is only a selection - if a task needs a tool you do not see, search here (by what the tool DOES, e.g. \"replace load stops\", \"send email\", \"research\") before ever concluding you cannot do something.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Words describing the capability you need." },
            },
            required: ["query"],
          },
          access: "read",
          run: async (args) => {
            const query = typeof args.query === "string" ? args.query : "";
            const offeredNames = new Set(offered.map((t) => t.name));
            const matches = searchToolCatalog(
              catalog.filter((t) => !offeredNames.has(t.name)),
              query,
              10,
            );
            if (matches.length === 0) {
              return (
                `No tool in your full toolset matches "${query}". Try different words for the same capability ` +
                "(the action or the record it touches). If it truly is not there, tell the owner plainly what is missing - do not invent a result."
              );
            }
            for (const match of matches) pendingExpansions.push(match);
            return (
              "Loaded for the rest of this turn - call the one you need directly:\n" +
              matches
                .map((m) => `- ${m.name}: ${m.description.split(/(?<=[.])\s/)[0]?.slice(0, 180) ?? ""}`)
                .join("\n")
            );
          },
        }
      : null;

  const offered: AgentTool[] = finder ? [finder, ...input.tools] : [...input.tools];
  const toolsByName = new Map(offered.map((tool) => [tool.name, tool]));

  // Tools pulled in this turn are eviction-protected (they sit at the tail, so without this a
  // batch pull would evict its own earlier matches to make room for its later ones).
  const expandedNames = new Set<string>();
  /** Index of the last evictable offered tool: an uncalled, unpulled READ that is not the finder. */
  const evictableIndex = (): number => {
    for (let i = offered.length - 1; i >= 0; i--) {
      const t = offered[i]!;
      if (
        t.access === "read" &&
        t.name !== FIND_MORE_TOOLS_NAME &&
        !calledNames.has(t.name) &&
        !expandedNames.has(t.name)
      ) {
        return i;
      }
    }
    return -1;
  };
  const applyExpansions = () => {
    while (pendingExpansions.length > 0) {
      const tool = pendingExpansions.shift()!;
      if (toolsByName.has(tool.name)) continue;
      if (offered.length >= specLimit) {
        const evictAt = evictableIndex();
        if (evictAt < 0) break; // nothing safe to evict; leave the rest pending for a later step
        const [evicted] = offered.splice(evictAt, 1);
        if (evicted) toolsByName.delete(evicted.name);
      }
      offered.push(tool);
      toolsByName.set(tool.name, tool);
      expandedNames.add(tool.name);
    }
  };
  // The finder itself takes a spec slot: if the selection already filled the limit, trim
  // tail filler reads BEFORE the first provider call so no request ever exceeds the limit.
  while (offered.length > specLimit) {
    const evictAt = evictableIndex();
    if (evictAt < 0) break;
    const [evicted] = offered.splice(evictAt, 1);
    if (evicted) toolsByName.delete(evicted.name);
  }

  const messages: AiAgentMessage[] = [
    { role: "system", content: input.system },
    ...input.history.map(
      (turn): AiAgentMessage => ({ role: turn.role, content: turn.text }),
    ),
    {
      role: "user",
      content: input.contextText
        ? `${input.contextText}\n\nOWNER'S NEW MESSAGE:\n${input.userText}`
        : input.userText,
    },
  ];

  const groundingParts: string[] = [input.contextText, input.userText];
  const proposals: ProposedWrite[] = [];
  const toolLog: AgentToolLogEntry[] = [];
  const log = (entry: AgentToolLogEntry) => {
    toolLog.push(entry);
    input.onToolLog?.(entry);
  };

  let stepsUsed = 0;
  while (stepsUsed < maxSteps) {
    stepsUsed += 1;
    applyExpansions();
    const specs = offered.map(specFor);
    const turn = await provider.runToolTurn(messages, specs);

    if (turn.toolCalls.length === 0) {
      const text = turn.text?.trim();
      if (!text) {
        return {
          reply: "I didn't get an answer back on that one - try again in a moment.",
          proposals,
          toolLog,
          stepsUsed,
          ranOutOfSteps: false,
        };
      }
      const bad = ungroundedAmounts(text, groundingParts.join("\n"));
      return {
        reply: bad.length > 0 ? UNGROUNDED_FIGURE_REPLY : text,
        proposals,
        toolLog,
        stepsUsed,
        ranOutOfSteps: false,
      };
    }

    messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });

    for (const call of turn.toolCalls) {
      const tool = toolsByName.get(call.name);
      if (!tool) {
        // A real registry tool that simply was not in this turn's selection is NOT an error and
        // must never become "I can't do that": load it and have the model call it again.
        const fromCatalog = catalogByName.get(call.name);
        if (fromCatalog) {
          pendingExpansions.push(fromCatalog);
          applyExpansions();
          log({ tool: call.name, access: fromCatalog.access, outcome: "error", detail: "not in this turn's selection - loaded now" });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content:
              `"${call.name}" is in your full toolset but was not in this turn's selection. It is loaded now - ` +
              "call it again with the same arguments. Do not tell the owner you cannot do this.",
          });
        } else {
          log({ tool: call.name, access: "read", outcome: "error", detail: "unknown tool" });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content:
              `Error: there is no tool named "${call.name}". Use only the tools provided.` +
              (finder
                ? ` If the capability you need exists under another name, call ${FIND_MORE_TOOLS_NAME} to search your full toolset for it.`
                : ""),
          });
        }
        continue;
      }
      calledNames.add(tool.name);

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>;
      } catch {
        log({ tool: tool.name, access: tool.access, outcome: "error", detail: "unparseable arguments" });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `Error: your arguments for ${tool.name} were not valid JSON. Call it again with well-formed arguments.`,
        });
        continue;
      }

      if (
        tool.access === "write" &&
        (tool.alwaysPropose || (args.confirmation !== "execute" && !tool.immediateWhenNamed))
      ) {
        const { confirmation: _dropped, ...writeArgs } = args;
        void _dropped;

        // §9 dump staging: one call expands into many proposals,
        // each validated in code before it is stored; rejected
        // extractions are reported, never staged.
        if (tool.expandProposals) {
          const expanded = tool.expandProposals(writeArgs, { userText: input.userText });
          for (const proposal of expanded.proposals) {
            proposals.push(proposal);
            log({ tool: proposal.tool, access: "write", outcome: "proposed", detail: proposal.summary });
          }
          const lines = [
            expanded.proposals.length > 0
              ? `STAGED ${expanded.proposals.length} proposed item(s) from his message - NOTHING is recorded yet; the items are listed to him verbatim after your reply and take effect only when he approves them:`
              : "No items were staged from that message.",
            ...expanded.proposals.map((p, i) => `${i + 1}. ${p.summary}`),
            ...expanded.rejected.map((r) => `REJECTED (not staged): ${r.summary} - ${r.reason}`),
          ];
          const content = lines.join("\n");
          groundingParts.push(content);
          messages.push({ role: "tool", toolCallId: call.id, content });
          continue;
        }

        // Validate BEFORE anything is shown or stored: a proposal that
        // could not execute (a broker NAME where a uuid belongs) must
        // never reach the owner as something to approve. The error goes
        // back to the model so it can resolve the field and try again.
        let proposedArgs = writeArgs;
        if (tool.validateArgs) {
          const checked = tool.validateArgs(writeArgs);
          if (!checked.ok) {
            log({ tool: tool.name, access: "write", outcome: "error", detail: `invalid proposal: ${checked.error}` });
            messages.push({
              role: "tool",
              toolCallId: call.id,
              content:
                `NOT PROPOSED - these arguments would be refused: ${checked.error}. Nothing was staged. ` +
                "Look up the real value with a read tool (ids come from list_contacts / the list tools, never a name) or ask the owner for the missing field, then propose again.",
            });
            continue;
          }
          proposedArgs = checked.args;
        }
        let verifiedSummary: string | undefined;
        if (tool.verifyProposal) {
          let verdict: { ok: true; summary?: string } | { ok: false; error: string };
          try {
            verdict = await tool.verifyProposal(proposedArgs);
          } catch (err) {
            verdict = { ok: false, error: err instanceof Error ? err.message : "could not check his records" };
          }
          if (!verdict.ok) {
            log({ tool: tool.name, access: "write", outcome: "error", detail: `unverified proposal: ${verdict.error}` });
            messages.push({
              role: "tool",
              toolCallId: call.id,
              content:
                `NOT PROPOSED - ${verdict.error}. Nothing was staged and nothing was shown to him. ` +
                "Find the real record with a read tool (list_loads, list_memories, list_documents, list_open_threads ...) and propose again with its id - or tell him you couldn't find it.",
            });
            continue;
          }
          verifiedSummary = verdict.summary;
        }
        const summary = verifiedSummary ?? (tool.summarize ? tool.summarize(proposedArgs) : `${tool.name} (proposed)`);
        proposals.push({ tool: tool.name, args: proposedArgs, summary });
        log({ tool: tool.name, access: "write", outcome: "proposed", detail: summary });
        const content =
          `PROPOSED, not recorded: ${summary}. It will only be recorded if the owner replies YES. ` +
          "Tell him plainly that this is a proposal awaiting his yes - do not say it was saved.";
        // The proposal text is grounding too: its figures are shown to
        // the owner verbatim (appended by the caller) for his decision.
        groundingParts.push(content);
        messages.push({ role: "tool", toolCallId: call.id, content });
        continue;
      }

      const { confirmation: _dropped, ...runArgs } = args;
      void _dropped;
      try {
        const result = await tool.run(runArgs);
        groundingParts.push(result);
        log({ tool: tool.name, access: tool.access, outcome: "executed" });
        messages.push({ role: "tool", toolCallId: call.id, content: result });
      } catch (err) {
        const detail = err instanceof Error ? err.message : "unknown error";
        log({ tool: tool.name, access: tool.access, outcome: "error", detail });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content:
            `Error running ${tool.name}: ${detail}. Tell the owner this lookup/write failed - ` +
            "do not invent a result to cover for it.",
        });
      }
    }
  }

  return {
    reply: RAN_OUT_OF_STEPS_REPLY,
    proposals,
    toolLog,
    stepsUsed,
    ranOutOfSteps: true,
  };
}
