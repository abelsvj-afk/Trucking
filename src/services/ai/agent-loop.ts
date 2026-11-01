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

import {
  isAgentCapableProvider,
  type AiAgentMessage,
  type AiProvider,
  type AiToolSpec,
} from "./provider";
import type { BotChatTurn } from "./bot-chat";

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
   * Validates raw proposed arguments without executing (§9). Used
   * by dump staging to check an extracted item against the target
   * tool's own Zod schema before it is stored as a proposal.
   */
  validateArgs?: (
    args: Record<string, unknown>,
  ) => { ok: true; args: Record<string, unknown> } | { ok: false; error: string };
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
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const specs = input.tools.map(specFor);

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
        log({ tool: call.name, access: "read", outcome: "error", detail: "unknown tool" });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `Error: there is no tool named "${call.name}". Use only the tools provided.`,
        });
        continue;
      }

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

      if (tool.access === "write" && (args.confirmation !== "execute" || tool.alwaysPropose)) {
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

        const summary = tool.summarize ? tool.summarize(writeArgs) : `${tool.name} (proposed)`;
        proposals.push({ tool: tool.name, args: writeArgs, summary });
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
