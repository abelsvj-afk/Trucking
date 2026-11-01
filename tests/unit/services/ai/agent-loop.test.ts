// Bot intelligence v2 (docs/design/driver-mvp.md §8). The agent
// loop's guarantees, tested with a scripted provider - no network,
// no real model:
// - read tools run and their real output grounds the reply;
// - a dollar figure that traces to NO tool result / context / owner
//   message never reaches the reply (the grounding guard);
// - a bot-proposed write is NOT executed without the owner's yes;
// - a directly ordered write (confirmation: "execute") runs at once;
// - the step cap ends the loop with an honest fallback, not a guess.

import { describe, expect, it, vi } from "vitest";
import {
  MAX_AGENT_STEPS,
  RAN_OUT_OF_STEPS_REPLY,
  UNGROUNDED_FIGURE_REPLY,
  runAgentLoop,
  type AgentTool,
} from "@/services/ai/agent-loop";
import type {
  AiAgentMessage,
  AiToolSpec,
  AiToolTurnResult,
  AgentCapableProvider,
} from "@/services/ai/provider";

function scriptedProvider(turns: AiToolTurnResult[]) {
  let index = 0;
  const calls: { messages: AiAgentMessage[]; tools: AiToolSpec[] }[] = [];
  const provider: AgentCapableProvider = {
    complete: async () => {
      throw new Error("complete() is not used by the agent loop");
    },
    runToolTurn: async (messages, tools) => {
      calls.push({ messages, tools });
      const turn = turns[Math.min(index, turns.length - 1)]!;
      index += 1;
      return turn;
    },
  };
  return { provider, calls };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): AiToolTurnResult {
  return { text: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}

function textTurn(text: string): AiToolTurnResult {
  return { text, toolCalls: [] };
}

const moneyTool = (run: () => Promise<string>): AgentTool => ({
  name: "money_summary",
  description: "Expense and fuel totals.",
  parameters: { type: "object", properties: {} },
  access: "read",
  run,
});

const expenseTool = (run: (args: Record<string, unknown>) => Promise<string>): AgentTool => ({
  name: "create_expense",
  description: "Record an expense.",
  parameters: {
    type: "object",
    properties: { category: { type: "string" }, amount_dollars: { type: "number" } },
    required: ["category", "amount_dollars"],
  },
  access: "write",
  summarize: (args) => `Expense: $${Number(args.amount_dollars).toFixed(2)} (${String(args.category)})`,
  run,
});

const baseInput = {
  system: "test system",
  contextText: "CURRENT SNAPSHOT: no figures here.",
  history: [],
  userText: "How much did I spend on fuel?",
};

describe("runAgentLoop", () => {
  it("answers from a read tool's real output", async () => {
    const run = vi.fn(async () => "Expenses total: $250.00\nFuel total: $482.10");
    const { provider } = scriptedProvider([
      toolCall("c1", "money_summary", {}),
      textTurn("You spent $482.10 on fuel."),
    ]);

    const out = await runAgentLoop({ ...baseInput, provider, tools: [moneyTool(run)] });

    expect(run).toHaveBeenCalledTimes(1);
    expect(out.reply).toBe("You spent $482.10 on fuel.");
    expect(out.toolLog).toEqual([{ tool: "money_summary", access: "read", outcome: "executed" }]);
    expect(out.ranOutOfSteps).toBe(false);
  });

  it("never lets a figure through that no tool result, context, or owner message contains", async () => {
    const { provider } = scriptedProvider([textTurn("You spent $999.99 on fuel last week.")]);

    const out = await runAgentLoop({ ...baseInput, provider, tools: [moneyTool(vi.fn())] });

    expect(out.reply).toBe(UNGROUNDED_FIGURE_REPLY);
    expect(out.reply).not.toContain("999.99");
  });

  it("lets through a figure the owner himself stated", async () => {
    const { provider } = scriptedProvider([textTurn("Right - the $75.50 toll receipt.")]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      userText: "I paid $75.50 in tolls today",
      tools: [moneyTool(vi.fn())],
    });

    expect(out.reply).toBe("Right - the $75.50 toll receipt.");
  });

  it("does NOT execute a bot-proposed write - it records a proposal instead", async () => {
    const run = vi.fn(async () => "Recorded.");
    const { provider } = scriptedProvider([
      toolCall("c1", "create_expense", { category: "repairs", amount_dollars: 45, confirmation: "propose" }),
      textTurn("I can record that $45.00 repair if you want - it is not saved yet."),
    ]);

    const out = await runAgentLoop({ ...baseInput, provider, tools: [expenseTool(run)] });

    expect(run).not.toHaveBeenCalled();
    expect(out.proposals).toEqual([
      { tool: "create_expense", args: { category: "repairs", amount_dollars: 45 }, summary: "Expense: $45.00 (repairs)" },
    ]);
    expect(out.toolLog[0]).toMatchObject({ tool: "create_expense", access: "write", outcome: "proposed" });
    expect(out.reply).toContain("not saved yet");
  });

  it("executes immediately when the owner directly ordered the write", async () => {
    const run = vi.fn(async (_args: Record<string, unknown>) => "Recorded expense $120.00 (other).");
    const { provider } = scriptedProvider([
      toolCall("c1", "create_expense", { category: "other", amount_dollars: 120, confirmation: "execute" }),
      textTurn("Recorded - $120.00 is in your books."),
    ]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      userText: "Log $120 for the Pilot stop",
      tools: [expenseTool(run)],
    });

    expect(run).toHaveBeenCalledTimes(1);
    // The loop strips its own confirmation argument before executing.
    expect(run).toHaveBeenCalledWith({ category: "other", amount_dollars: 120 });
    expect(out.proposals).toEqual([]);
    expect(out.reply).toBe("Recorded - $120.00 is in your books.");
  });

  it("stops at the step cap with an honest fallback instead of a fabricated answer", async () => {
    const looping = toolCall("c1", "money_summary", {});
    const { provider } = scriptedProvider([looping]);
    const run = vi.fn(async () => "Expenses total: $250.00");

    const out = await runAgentLoop({ ...baseInput, provider, tools: [moneyTool(run)] });

    expect(out.ranOutOfSteps).toBe(true);
    expect(out.stepsUsed).toBe(MAX_AGENT_STEPS);
    expect(out.reply).toBe(RAN_OUT_OF_STEPS_REPLY);
  });

  it("surfaces a tool error to the model instead of inventing a result", async () => {
    const run = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const { provider, calls } = scriptedProvider([
      toolCall("c1", "money_summary", {}),
      textTurn("That lookup failed - I couldn't reach your records just now."),
    ]);

    const out = await runAgentLoop({ ...baseInput, provider, tools: [moneyTool(run)] });

    expect(out.toolLog[0]).toMatchObject({ outcome: "error", detail: "database unavailable" });
    const toolMessage = calls[1]!.messages.find((m) => m.role === "tool");
    expect(toolMessage && "content" in toolMessage ? toolMessage.content : "").toContain("database unavailable");
    expect(out.reply).toContain("failed");
  });
});
