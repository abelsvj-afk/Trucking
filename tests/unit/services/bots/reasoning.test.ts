// Shared reasoning: the ten forms Abel was promised, now the shared
// brain every bot uses. One brain, not a cut-down version — a bot
// that cannot reach all ten forms is a bug, and this test names it.
import { describe, expect, it } from "vitest";
import {
  buildSharedReasoningText,
  CAUSAL_RULES,
  CONSOLIDATION_RULES,
  CONTEXTUAL_RULES,
  EPISODIC_RULES,
  PRACTICAL_RULES,
  RESTRAINT_RULES,
  SELF_CORRECTION_RULES,
  SHARED_REASONING_BLOCKS,
  TEMPORAL_RULES,
  THEORY_OF_MIND_RULES,
  TOOL_SELECTION_RULES,
  VALUE_LEARNING_RULES,
} from "@/services/bots/reasoning";

describe("shared reasoning", () => {
  it("has exactly the ten forms, in Abel's assembly order", () => {
    expect(SHARED_REASONING_BLOCKS.map((b) => b.form)).toEqual([
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
  });

  it("every form is a non-empty, distinct block", () => {
    const texts = SHARED_REASONING_BLOCKS.map((b) => b.text);
    for (const text of texts) {
      expect(text.trim().length).toBeGreaterThan(50);
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("each form carries its marker line", () => {
    expect(TEMPORAL_RULES).toMatch(/^TIME:/);
    expect(CONTEXTUAL_RULES).toMatch(/^CONTEXT:/);
    expect(CAUSAL_RULES).toMatch(/CAUSE BEFORE CONCLUSION/);
    expect(PRACTICAL_RULES).toMatch(/^PRACTICAL:/);
    expect(SELF_CORRECTION_RULES).toMatch(/OWN YOUR MISTAKES/);
    expect(EPISODIC_RULES).toMatch(/EPISODES, NOT JUST FACTS/);
    expect(THEORY_OF_MIND_RULES).toMatch(/WHAT HE KNOWS/);
    expect(VALUE_LEARNING_RULES).toMatch(/LEARN WHAT HE VALUES/);
    expect(CONSOLIDATION_RULES).toMatch(/USE WHAT YOU ALREADY LEARNED/);
    expect(RESTRAINT_RULES).toMatch(/KNOW WHEN TO STOP/);
  });

  it("PRACTICAL lives inside TOOL_SELECTION_RULES verbatim — Abel's assembly is unchanged", () => {
    expect(TOOL_SELECTION_RULES).toContain(PRACTICAL_RULES);
    expect(TOOL_SELECTION_RULES).toMatch(/^TOOL SELECTION:/);
  });

  it("the joined text carries all ten forms", () => {
    const joined = buildSharedReasoningText();
    for (const block of SHARED_REASONING_BLOCKS) {
      expect(joined).toContain(block.text);
    }
  });
});
