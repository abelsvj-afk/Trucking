// Audit F-009/F-015: the write-intent gate. A gated write EXECUTES only when his own words
// order it; questions, negations and quoted text turn it into a proposal he approves.
import { describe, expect, it } from "vitest";
import type { AgentTool } from "@/services/ai/agent-loop";
import { gateExecutes, NAMED_ACTION_PATTERNS, namesAction } from "@/services/bot/execute-gate";

const tool = (name: string) => ({ name, description: "", parameters: {}, access: "write", run: async () => "" }) as unknown as AgentTool;
const executes = (name: string, text: string) => !gateExecutes([tool(name)], text)[0]!.alwaysPropose;

describe("write-intent gate matrix", () => {
  const orders: [string, string][] = [
    ["complete_load", "Delivered the load in Tampa."],
    ["complete_load", "Mark it delivered"],
    ["complete_load", "can you mark trip 1903 delivered?"],
    ["update_load", "Change the rate to 2400"],
    ["update_load", "The miles should be 612"],
    ["record_load_decision", "I took the Atlanta load"],
    ["record_load_decision", "Pass on that one."],
    ["mark_thread_answered", "I replied to him already, close the thread"],
    ["draft_email_reply", "draft a reply to the broker"],
  ];
  it.each(orders)("%s executes on a real order: %s", (name, text) => {
    expect(executes(name, text)).toBe(true);
  });

  const notOrders: [string, string][] = [
    // questions
    ["complete_load", "Did I mark the Tampa load delivered?"],
    ["update_load", "How many miles is the Atlanta load?"],
    ["record_load_decision", "Should I take the Atlanta load?"],
    ["update_load", "what's the rate on it?"],
    // negations
    ["complete_load", "Don't mark it delivered yet"],
    ["complete_load", "It's not delivered, still waiting at the dock."],
    ["record_load_decision", "I never accepted that load"],
    ["update_load", "don't change the rate"],
    // quoted / forwarded text
    ["record_load_decision", 'Broker wrote: "we booked you on 1903"'],
    ["complete_load", "> Load delivered at 3:40 PM\nwhat is this about"],
    // nothing about it at all
    ["mark_thread_answered", "Just completed the load"],
  ];
  it.each(notOrders)("%s becomes a proposal: %s", (name, text) => {
    expect(executes(name, text)).toBe(false);
  });

  it("an order sentence still counts when a question sits beside it", () => {
    expect(namesAction(NAMED_ACTION_PATTERNS.complete_load!, "Delivered in Tampa. What's next?")).toBe(true);
  });

  it("never loosens: an always-propose tool stays a proposal however it is worded", () => {
    const t = { ...tool("complete_load"), alwaysPropose: true } as AgentTool;
    expect(gateExecutes([t], "Mark it delivered")[0]!.alwaysPropose).toBe(true);
  });
});
