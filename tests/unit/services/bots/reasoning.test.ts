// Shared reasoning engine: every bot reasons with all ten of
// Abel's forms — same brain, different job/tools/memory. Nothing
// cut down, nothing silently dropped.
import { describe, expect, it } from "vitest";
import {
  ALL_REASONING_FORMS,
  canonicalReasoningInstructionsFor,
  EXTENDED_REASONING_FORM_IDS,
  EXTENDED_REASONING_FORMS,
  REASONING_FORM_IDS,
  REASONING_FORMS,
  reasoningInstructionsFor,
} from "@/services/bots/reasoning";

/** Tool names that belong to Abel's job only — they must never leak into another bot's reasoning. */
const ABEL_ONLY_TOOL_NAMES = [
  "set_load_stops",
  "get_pay_status",
  "record_load_decision",
  "recommend_loads",
  "lane_rate_history",
  "delivery_feasibility",
  "evaluate_plan",
  "find_more_tools",
  "save_memory",
  "search_memory",
  "when_is",
  "time_between",
  "load_calendar",
  "whats_due",
  "timeline",
];

describe("shared reasoning engine", () => {
  it("has exactly the ten canonical forms", () => {
    expect([...REASONING_FORM_IDS]).toEqual([
      "temporal",
      "contextual",
      "causal",
      "practical",
      "self-correction",
      "episodic",
      "theory-of-mind",
      "value-learning",
      "consolidation",
      "restraint",
    ]);
    expect(REASONING_FORMS).toHaveLength(10);
    expect(REASONING_FORMS.every((form) => form.canonical)).toBe(true);
  });

  it("carries the five extended 'think deeper' forms separately, never silently dropped", () => {
    expect([...EXTENDED_REASONING_FORM_IDS]).toEqual(["chained", "verification", "uncertainty", "tradeoff", "prediction"]);
    expect(EXTENDED_REASONING_FORMS).toHaveLength(5);
    expect(EXTENDED_REASONING_FORMS.every((form) => !form.canonical)).toBe(true);
    expect(ALL_REASONING_FORMS).toHaveLength(15);
  });

  it("builds all fifteen blocks for Billing, each non-empty", () => {
    const blocks = reasoningInstructionsFor("billing");
    expect(blocks).toHaveLength(15);
    for (const block of blocks) expect(block.trim().length).toBeGreaterThan(50);
    expect(blocks.join("\n")).toMatch(/Billing/);
  });

  it("builds the canonical ten alone on request", () => {
    const blocks = canonicalReasoningInstructionsFor("billing");
    expect(blocks).toHaveLength(10);
    expect(blocks[0]).toMatch(/^TIME:/);
  });

  it("never names another bot's tools in Billing's reasoning", () => {
    const text = reasoningInstructionsFor("billing").join("\n");
    for (const tool of ABEL_ONLY_TOOL_NAMES) {
      expect(text).not.toContain(tool);
    }
    expect(text).not.toMatch(/\bHOS\b/);
    expect(text).not.toMatch(/dispatch board/i);
  });

  it("parameterizes the practical form per bot — same form, own job", () => {
    const billing = canonicalReasoningInstructionsFor("billing").find((b) => b.startsWith("PRACTICAL:"));
    const abel = canonicalReasoningInstructionsFor("abel").find((b) => b.startsWith("PRACTICAL:"));
    expect(billing).toContain("Billing");
    expect(billing).toContain("turning a delivered load into money in, on time");
    expect(abel).toContain("Abel");
    expect(billing).not.toBe(abel);
  });

  it("keeps every form's behavioral core: temporal dates, causal why-first, verification re-check", () => {
    const text = reasoningInstructionsFor("billing").join("\n");
    expect(text).toMatch(/never work out a weekday/i);
    expect(text).toMatch(/CAUSE BEFORE CONCLUSION/);
    expect(text).toMatch(/CHECK BEFORE YOU SEND/);
    expect(text).toMatch(/SAY WHAT YOU DON'T KNOW/);
    expect(text).toMatch(/FORECAST, DON'T BLOCK/);
    expect(text).toMatch(/KNOW WHEN TO STOP/);
  });
});
