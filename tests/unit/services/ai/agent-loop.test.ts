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

  it("a proposal whose arguments would be refused is never staged, and the model is told why", async () => {
    const strictTool: AgentTool = {
      ...expenseTool(vi.fn()),
      name: "create_load_like",
      validateArgs: (args) =>
        typeof args.broker_id === "string" && /^[0-9a-f-]{36}$/.test(args.broker_id)
          ? { ok: true, args }
          : { ok: false, error: "broker_id: Invalid uuid" },
    };
    const { provider, calls } = scriptedProvider([
      toolCall("c1", "create_load_like", { broker_id: "Example Logistics", category: "x", amount_dollars: 1 }),
      textTurn("I need the broker's id first."),
    ]);
    const out = await runAgentLoop({ ...baseInput, provider, tools: [strictTool] });
    expect(out.proposals).toEqual([]);
    expect(out.toolLog[0]).toMatchObject({ outcome: "error" });
    const toolMsg = calls[1]!.messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMsg)).toContain("NOT PROPOSED");
    expect(JSON.stringify(toolMsg)).toContain("broker_id: Invalid uuid");
  });
});

// Think deeper, Frontier 1 (owner GO 2026-11-11): the self-verification
// pass. A draft that quotes a dollar figure a LATER tool result
// superseded is caught before send - the model gets one chance to
// answer again with the fresh figure, and a second stale draft comes
// back as an explicit conflict flag, never as a confident answer.
// Answers with no numbers cost nothing extra: no extra model call.
describe("runAgentLoop - self-verification pass (think deeper, Frontier 1)", () => {
  // A read tool whose successive calls return different labeled
  // figures - the seeded stale-number shape: an early lookup says
  // $611.20, a later re-read says $650.00.
  const payLookupTool = (results: string[]): AgentTool => {
    let index = 0;
    const run = vi.fn(async () => results[Math.min(index++, results.length - 1)]!);
    return {
      name: "pay_lookup",
      description: "Projected pay for the load.",
      parameters: { type: "object", properties: {} },
      access: "read",
      run,
    };
  };

  it("F1-A: a draft quoting the superseded figure is caught, and the corrected figure is what he gets", async () => {
    const { provider, calls } = scriptedProvider([
      toolCall("c1", "pay_lookup", {}),
      toolCall("c2", "pay_lookup", {}),
      textTurn("Your pay is $611.20."),
      textTurn("Your pay is $650.00."),
    ]);
    const out = await runAgentLoop({
      ...baseInput,
      provider,
      userText: "What will I make on this load?",
      tools: [payLookupTool(["Projected pay: $611.20", "Projected pay: $650.00"])],
    });

    expect(out.reply).toBe("Your pay is $650.00.");
    expect(out.reply).not.toContain("$611.20");
    expect(out.verificationRetries).toBe(1);
    // The retry carried the conflict to the model in code, not as his words.
    const retryMessages = JSON.stringify(calls[3]!.messages);
    expect(retryMessages).toMatch(/VERIFICATION/);
    expect(retryMessages).toContain("$611.20");
    expect(retryMessages).toContain("$650.00");
  });

  it("F1-A: a second stale draft is flagged as a conflict, never sent as confident - and retried only once", async () => {
    const { provider, calls } = scriptedProvider([
      toolCall("c1", "pay_lookup", {}),
      toolCall("c2", "pay_lookup", {}),
      textTurn("Your pay is $611.20."),
      textTurn("Your pay is $611.20."),
    ]);
    const out = await runAgentLoop({
      ...baseInput,
      provider,
      userText: "What will I make on this load?",
      tools: [payLookupTool(["Projected pay: $611.20", "Projected pay: $650.00"])],
    });

    expect(out.reply).toMatch(/stale/i);
    expect(out.reply).toContain("$650.00");
    expect(out.verificationRetries).toBe(1);
    expect(calls).toHaveLength(4);
    expect(out.stepsUsed).toBe(4);
  });

  it("F1-A: a draft that shows BOTH figures (the conflict, honestly) is not flagged", async () => {
    const { provider } = scriptedProvider([
      toolCall("c1", "pay_lookup", {}),
      toolCall("c2", "pay_lookup", {}),
      textTurn("First lookup said $611.20 but the re-read says $650.00 - those two don't match."),
    ]);
    const out = await runAgentLoop({
      ...baseInput,
      provider,
      userText: "What will I make on this load?",
      tools: [payLookupTool(["Projected pay: $611.20", "Projected pay: $650.00"])],
    });

    expect(out.reply).toContain("$611.20");
    expect(out.reply).toContain("$650.00");
    expect(out.verificationRetries).toBe(0);
  });

  it("verbatim stays verbatim: the verification pass never rewrites a verbatim relay", async () => {
    const verbatimTool: AgentTool = {
      name: "read_email_verbatim",
      description: "Read an email exactly as stored.",
      parameters: { type: "object", properties: {} },
      access: "read",
      verbatimRelay: true,
      run: async () => "The settlement says: Projected pay: $611.20.",
    };
    const { provider } = scriptedProvider([
      toolCall("c1", "read_email_verbatim", {}),
      toolCall("c2", "pay_lookup", {}),
      textTurn("The settlement says $611.20."),
    ]);
    const out = await runAgentLoop({
      ...baseInput,
      provider,
      tools: [verbatimTool, payLookupTool(["Projected pay: $650.00"])],
    });

    expect(out.reply).toBe("The settlement says: Projected pay: $611.20.");
    expect(out.verificationRetries).toBe(0);
  });

  it("F1-D: an answer with no numbers costs no extra model call", async () => {
    const { provider, calls } = scriptedProvider([textTurn("Got it - I'll check the load next.")]);
    const out = await runAgentLoop({ ...baseInput, provider, tools: [moneyTool(vi.fn())] });

    expect(calls).toHaveLength(1);
    expect(out.stepsUsed).toBe(1);
    expect(out.verificationRetries).toBe(0);
    expect(out.verificationMs).toEqual(expect.any(Number));
    expect(out.verificationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("model-execute guard (Telegram review D3 path)", () => {
  // The exact write is already waiting for his yes: the model must
  // NOT execute it mid-turn (the "not sure, no" failure was the
  // model executing the pending duty write instead of waiting).
  const pendingExpense = async (toolName: string, args: Record<string, unknown>) =>
    toolName === "create_expense" && args.category === "repairs" && args.amount_dollars === 45;

  it("refuses to execute a write that is already waiting for his yes", async () => {
    const run = vi.fn(async () => "Recorded.");
    const { provider, calls } = scriptedProvider([
      toolCall("c1", "create_expense", { category: "repairs", amount_dollars: 45, confirmation: "execute" }),
      textTurn("It's already on your waiting list - say YES to record it."),
    ]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      tools: [expenseTool(run)],
      isWriteAlreadyPending: pendingExpense,
    });

    expect(run).not.toHaveBeenCalled();
    expect(out.proposals).toEqual([]);
    expect(out.toolLog).toContainEqual({ tool: "create_expense", access: "write", outcome: "error", detail: "already pending approval" });
    expect(out.reply).toBe("It's already on your waiting list - say YES to record it.");
    // The refusal reaches the model as a tool message, so it can answer from it.
    const toolMessages = calls[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMessages[0]?.content).toContain("NOT EXECUTED - that exact write is already waiting for his yes");
  });

  it("executes the same write when nothing is waiting", async () => {
    const run = vi.fn(async () => "Recorded expense $45.00 (repairs).");
    const { provider } = scriptedProvider([
      toolCall("c1", "create_expense", { category: "repairs", amount_dollars: 45, confirmation: "execute" }),
      textTurn("Recorded."),
    ]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      tools: [expenseTool(run)],
      isWriteAlreadyPending: async () => false,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ category: "repairs", amount_dollars: 45 });
    expect(out.reply).toBe("Recorded.");
  });

  it("a different write is not blocked by an unrelated pending row", async () => {
    const run = vi.fn(async () => "Recorded.");
    const { provider } = scriptedProvider([
      toolCall("c1", "create_expense", { category: "fuel", amount_dollars: 120, confirmation: "execute" }),
      textTurn("Recorded."),
    ]);

    await runAgentLoop({
      ...baseInput,
      provider,
      tools: [expenseTool(run)],
      isWriteAlreadyPending: pendingExpense,
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a guard-check failure never blocks a write", async () => {
    const run = vi.fn(async () => "Recorded.");
    const { provider } = scriptedProvider([
      toolCall("c1", "create_expense", { category: "repairs", amount_dollars: 45, confirmation: "execute" }),
      textTurn("Recorded."),
    ]);

    await runAgentLoop({
      ...baseInput,
      provider,
      tools: [expenseTool(run)],
      isWriteAlreadyPending: async () => {
        throw new Error("db down");
      },
    });

    expect(run).toHaveBeenCalledTimes(1);
  });
});
