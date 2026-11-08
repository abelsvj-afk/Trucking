import { describe, expect, it } from "vitest";
import { buildBotTools } from "@/services/bot/tools";
import { PROVIDER_TOOL_LIMIT, TOOL_BUDGET, selectToolsForTurn } from "@/services/bot/tool-budget";
import { gateExecutes } from "@/services/bot/execute-gate";

const store = { client: {}, companyId: "c", channel: "telegram" } as never;
const all = buildBotTools(store);

describe("the tool budget (Abel was down: more than 128 tools per request is rejected by the API)", () => {
  it("the registry is bigger than the limit, so selection is what keeps every message working", () => {
    expect(all.length).toBeGreaterThan(PROVIDER_TOOL_LIMIT);
  });

  it.each(["hello", "what did I spend on fuel this week", "is the Atlanta load rate good", "show my inbox and draft a reply", "when do I get paid and what advances"])(
    "'%s' offers the model at most the budget, always under the provider limit",
    (text) => {
      const picked = selectToolsForTurn(all, text);
      expect(picked.length).toBeLessThanOrEqual(TOOL_BUDGET);
      expect(picked.length).toBeLessThan(PROVIDER_TOOL_LIMIT);
      expect(gateExecutes(picked, text).length).toBe(picked.length);
    },
  );

  it("every write tool is always offered, so a proposal is always possible", () => {
    const writes = all.filter((t) => t.access !== "read").map((t) => t.name);
    const picked = new Set(selectToolsForTurn(all, "hello").map((t) => t.name));
    expect(writes.filter((n) => !picked.has(n))).toEqual([]);
  });

  it("the reads that match what he said are kept", () => {
    const names = (text: string) => new Set(selectToolsForTurn(all, text).map((t) => t.name));
    expect(names("what is in my email inbox").has("email_inbox")).toBe(true);
    expect(names("when is my next payday").has("paychecks_by_payday")).toBe(true);
    expect(names("any news today").has("news_digest")).toBe(true);
  });

  it("is deterministic and keeps registry order", () => {
    const a = selectToolsForTurn(all, "fuel").map((t) => t.name);
    const b = selectToolsForTurn(all, "fuel").map((t) => t.name);
    expect(a).toEqual(b);
    const order = all.map((t) => t.name);
    expect(a).toEqual(order.filter((n) => a.includes(n)));
  });

  it("a small registry is passed through untouched", () => {
    expect(selectToolsForTurn(all.slice(0, 10), "x")).toHaveLength(10);
  });

  it("no tool name is duplicated (a duplicate is also rejected by the API)", () => {
    const names = all.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
