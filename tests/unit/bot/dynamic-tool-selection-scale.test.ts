// Dynamic tool selection, second half (owner requirement, 2026-11-09, build #5):
// the domain, context, cap, and scale proofs the router + pull path must hold.
// - A turn about each major domain gets that domain's critical tools in the FIRST
//   selection against the REAL registry (no recovery needed for the common asks).
// - Selection is scored on conversation context too: a vague message in a thread
//   about a subject still surfaces that subject's tools.
// - The spec cap holds from the FIRST provider call: a full-budget selection plus
//   the finder never exceeds the limit (the finder takes a slot like any tool).
// - The registry can hold thousands of tools: selection stays capped and
//   deterministic, catalog search finds a deep tool by what it does, and a turn
//   at that scale still recovers the deep tool through find_more_tools.

import { describe, expect, it, vi } from "vitest";
import { FIND_MORE_TOOLS_NAME, runAgentLoop, type AgentTool } from "@/services/ai/agent-loop";
import type { AiAgentMessage, AiToolSpec, AiToolTurnResult, AgentCapableProvider } from "@/services/ai/provider";
import { buildBotTools } from "@/services/bot/tools";
import { searchToolCatalog, selectToolsForTurn, TOOL_BUDGET } from "@/services/bot/tool-budget";

const store = { client: {}, companyId: "c", channel: "telegram" } as never;
const registry = buildBotTools(store);
const pickedNames = (text: string) => new Set(selectToolsForTurn(registry, text).map((t) => t.name));

describe("domain turns against the real registry", () => {
  it.each([
    ["show me my loads", ["list_loads"]],
    ["what are the stops on the Panama City load", ["list_loads", "set_load_stops"]],
    ["when do I get paid and how much is coming on my next paycheck", ["paychecks_by_payday"]],
    ["what will I make this week", ["projected_pay", "weekly_pay_report"]],
    ["check my email inbox", ["email_inbox"]],
    ["what are you watching and what have you learned", ["list_watch_topics", "get_knowledge"]],
    ["show me the research briefings", ["list_research_briefings"]],
    ["list my documents", ["list_documents"]],
    ["search my documents for the seal photo", ["search_documents", "get_document"]],
    ["how much drive time do I have left on my hours", ["hos_summary"]],
    ["show my duty logs", ["list_duty_logs"]],
  ])("'%s' offers %j in the first selection", (text, critical) => {
    const names = pickedNames(text);
    for (const name of critical) expect(names.has(name), `${name} missing for "${text}"`).toBe(true);
  });

  it("stays within the budget for every domain phrasing", () => {
    for (const text of ["loads", "pay", "email", "research", "documents", "hours", "hello"]) {
      expect(selectToolsForTurn(registry, text).length).toBeLessThanOrEqual(TOOL_BUDGET);
    }
  });
});

describe("selection hears the conversation, not just the last message", () => {
  it("a vague reply in a knowledge thread still surfaces the knowledge tool", () => {
    // No signal in the message itself: the late-registry tool ranks out on fill order.
    expect(pickedNames("ok").has("get_knowledge")).toBe(false);
    // The same message with the thread's subject in the selection text: it ranks in.
    const withContext = pickedNames("ok\nOPEN LOOPS: stored knowledge from his research watch is waiting");
    expect(withContext.has("get_knowledge")).toBe(true);
  });
});

const readTool = (name: string, description: string, run?: () => Promise<string>): AgentTool => ({
  name,
  description,
  parameters: { type: "object", properties: {} },
  access: "read",
  run: run ?? (async () => `${name} result`),
});

function harness(steps: ((ctx: { tools: AiToolSpec[]; messages: AiAgentMessage[] }) => AiToolTurnResult)[]) {
  let index = 0;
  const seenSpecs: AiToolSpec[][] = [];
  const provider: AgentCapableProvider = {
    complete: async () => {
      throw new Error("complete() is not used by the agent loop");
    },
    runToolTurn: async (messages, tools) => {
      seenSpecs.push(tools);
      const step = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
      return step({ tools, messages });
    },
  };
  return { provider, seenSpecs };
}
const call = (id: string, name: string, args: Record<string, unknown>): AiToolTurnResult => ({
  text: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});
const say = (text: string): AiToolTurnResult => ({ text, toolCalls: [] });
const specNames = (tools: AiToolSpec[]) => tools.map((t) => t.name);
const baseInput = { system: "test", contextText: "", history: [] as never[], userText: "help" };

describe("the spec cap holds from the first call", () => {
  it("a full-budget selection plus the finder never exceeds the limit, and an evicted filler can be pulled back", async () => {
    const selection = selectToolsForTurn(registry, "hello");
    expect(selection.length).toBe(TOOL_BUDGET); // the router fills the budget today
    const dropped = registry.filter((t) => !selection.includes(t));
    expect(dropped.length).toBeGreaterThan(0);
    const pullTarget = dropped.find((t) => t.access === "read")!;
    const pullRun = vi.fn(async () => "pulled result");
    const catalog = registry.map((t) => (t.name === pullTarget.name ? { ...t, run: pullRun } : t));

    const { provider, seenSpecs } = harness([
      ({ tools }) => {
        expect(tools.length).toBeLessThanOrEqual(TOOL_BUDGET);
        expect(specNames(tools)).toContain(FIND_MORE_TOOLS_NAME);
        return call("s1", FIND_MORE_TOOLS_NAME, { query: pullTarget.name.replaceAll("_", " ") });
      },
      ({ tools }) => {
        expect(tools.length).toBeLessThanOrEqual(TOOL_BUDGET);
        expect(specNames(tools)).toContain(pullTarget.name);
        return call("s2", pullTarget.name, {});
      },
      () => say("Done."),
    ]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      tools: selection,
      toolCatalog: catalog,
      toolSpecLimit: TOOL_BUDGET,
    });
    expect(out.reply).toBe("Done.");
    expect(pullRun).toHaveBeenCalledTimes(1);
    for (const specs of seenSpecs) expect(specs.length).toBeLessThanOrEqual(TOOL_BUDGET);
  });
});

describe("a registry of thousands", () => {
  const big: AgentTool[] = [
    ...Array.from({ length: 1400 }, (_, i) => readTool(`read_capability_${i}`, `Reads record family ${i} and its history.`)),
    ...Array.from({ length: 600 }, (_, i) => ({
      ...readTool(`write_capability_${i}`, `Records entry family ${i}.`),
      access: "write" as const,
      summarize: () => "write",
    })),
    readTool("zephyr_manifest_lookup", "Finds the zephyr consignment manifest by its reference code."),
  ];

  it("selection stays capped and deterministic at 2,001 tools", () => {
    const a = selectToolsForTurn(big, "find the zephyr consignment manifest", TOOL_BUDGET);
    const b = selectToolsForTurn(big, "find the zephyr consignment manifest", TOOL_BUDGET);
    expect(a.length).toBeLessThanOrEqual(TOOL_BUDGET);
    expect(a.map((t) => t.name)).toEqual(b.map((t) => t.name));
    expect(a.map((t) => t.name)).toContain("zephyr_manifest_lookup");
  });

  it("catalog search finds a deep tool by what it does", () => {
    expect(searchToolCatalog(big, "zephyr consignment manifest reference").map((t) => t.name)).toContain(
      "zephyr_manifest_lookup",
    );
  });

  it("a turn at that scale recovers the deep tool through find_more_tools", async () => {
    const deepRun = vi.fn(async () => "manifest Z-9 found");
    const catalog = big.map((t) => (t.name === "zephyr_manifest_lookup" ? { ...t, run: deepRun } : t));
    const selection = selectToolsForTurn(catalog, "show me my loads and fuel", TOOL_BUDGET);
    expect(selection.map((t) => t.name)).not.toContain("zephyr_manifest_lookup");

    const { provider, seenSpecs } = harness([
      () => call("s1", FIND_MORE_TOOLS_NAME, { query: "zephyr consignment manifest" }),
      ({ tools }) => {
        expect(specNames(tools)).toContain("zephyr_manifest_lookup");
        return call("s2", "zephyr_manifest_lookup", {});
      },
      () => say("Manifest Z-9 found."),
    ]);

    const out = await runAgentLoop({
      ...baseInput,
      provider,
      userText: "find the zephyr thing",
      tools: selection,
      toolCatalog: catalog,
      toolSpecLimit: TOOL_BUDGET,
    });
    expect(deepRun).toHaveBeenCalledTimes(1);
    expect(out.reply).toBe("Manifest Z-9 found.");
    for (const specs of seenSpecs) expect(specs.length).toBeLessThanOrEqual(TOOL_BUDGET);
  });
});
