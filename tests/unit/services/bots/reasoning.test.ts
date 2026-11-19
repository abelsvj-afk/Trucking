// Shared reasoning: every bot gets ALL of Abel's reasoning forms,
// verbatim, through services/bots/reasoning.ts — no cut-down version.
// The brief says "ten"; Abel's prompt carries fourteen, so all
// fourteen are wired and none is dropped. The shared-reasoning engine
// reconciles the count when it lands; until then this list is the
// proof that Maintenance reaches every form Abel has.
import { describe, expect, it } from "vitest";
import { reasoningInstructions, SHARED_REASONING_BLOCKS, SHARED_REASONING_FORMS } from "@/services/bots/reasoning";

const EXPECTED_FORMS = [
  "temporal",
  "contextual",
  "causal",
  "self-correction",
  "episodic",
  "theory-of-mind",
  "value-learning",
  "consolidation",
  "restraint",
  "chained",
  "verification",
  "uncertainty",
  "tradeoff",
  "prediction",
] as const;

const FORM_MARKERS: Record<string, string> = {
  temporal: "TIME:",
  contextual: "CONTEXT:",
  causal: "CAUSE BEFORE CONCLUSION:",
  "self-correction": "OWN YOUR MISTAKES:",
  episodic: "EPISODES, NOT JUST FACTS:",
  "theory-of-mind": "WHAT HE KNOWS:",
  "value-learning": "LEARN WHAT HE VALUES FROM WHAT HE DOES:",
  consolidation: "USE WHAT YOU ALREADY LEARNED:",
  restraint: "KNOW WHEN TO STOP:",
  chained: "PLAN THEN ACT:",
  verification: "CHECK BEFORE YOU SEND:",
  uncertainty: "SAY WHAT YOU DON'T KNOW:",
  tradeoff: "SHOW BOTH SIDES OF THE MATH:",
  prediction: "FORECAST, DON'T BLOCK:",
};

describe("shared reasoning — all of Abel's forms, none dropped", () => {
  it("lists every reasoning form Abel's prompt carries, in prompt order", () => {
    expect(SHARED_REASONING_FORMS).toEqual([...EXPECTED_FORMS]);
    expect(SHARED_REASONING_BLOCKS).toHaveLength(EXPECTED_FORMS.length);
  });

  it("carries each form's text verbatim, non-empty and distinct", () => {
    const texts = SHARED_REASONING_BLOCKS.map((block) => block.text);
    for (const text of texts) {
      expect(text.trim().length).toBeGreaterThan(50);
    }
    expect(new Set(texts).size).toBe(texts.length);
    for (const block of SHARED_REASONING_BLOCKS) {
      expect(block.text).toContain(FORM_MARKERS[block.form]);
    }
  });

  it("exposes the forms as group-turn instructions, one per form", () => {
    const instructions = reasoningInstructions();
    expect(instructions).toHaveLength(EXPECTED_FORMS.length);
    for (const instruction of instructions) {
      expect(instruction.kind).toBe("reasoning");
      expect(instruction.content).toMatch(/^REASONING — [a-z-]+: /);
    }
  });

  it("does not smuggle in Abel's domain rules as reasoning forms", () => {
    // Learning (outcome logging), fleet, email, style, and tool
    // selection are separate concerns — they are not reasoning forms
    // and must not appear in this list.
    for (const form of SHARED_REASONING_FORMS) {
      expect(["learning", "fleet", "email", "style", "flair", "tool-selection"]).not.toContain(form);
    }
  });
});
