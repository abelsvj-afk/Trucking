// Shared reasoning for the Auditor (owner rule, 2026-11-19): one
// shared brain, not a cut-down version. The Auditor must be able to
// use ALL TEN of Abel's reasoning forms, through the shared
// reasoning — the only things that stay individual are its job, its
// scoped tools, and its memory.
//
// The ten forms are the 2026-11-10 reasoning layer (contextual,
// causal, practical, self-correction, episodic, theory of mind,
// value learning, consolidation, restraint) plus temporal
// (2026-11-07). The five Frontier 1 forms (2026-11-11) and the
// learning mechanism (2026-11-07) are Abel's reasoning too, so they
// are shared as well — itemised, never silently dropped. These
// tests pin the full set: 10 required + 5 Frontier 1 + learning.
//
// The shared text is NOT copied here: reasoning.ts imports the
// blocks from agent-turn.ts, the single source of truth. The test
// that compares the two proves there is no fork to drift.
import { describe, expect, it } from "vitest";
import {
  ALL_SHARED_REASONING_FORMS,
  AUDITOR_REASONING_OVERLAY,
  FRONTIER_REASONING_FORMS,
  LEARNING_FORM,
  TEN_REASONING_FORMS,
  buildAuditorReasoningPrompt,
  buildSharedReasoningPrompt,
  reasoningFormById,
  sharedReasoningText,
} from "@/services/bots/reasoning";
import {
  CAUSAL_RULES,
  CHAINED_REASONING_RULES,
  CONSOLIDATION_RULES,
  CONTEXTUAL_RULES,
  EPISODIC_RULES,
  LEARNING_RULES,
  PREDICTION_RULES,
  RESTRAINT_RULES,
  SELF_CORRECTION_RULES,
  TEMPORAL_RULES,
  THEORY_OF_MIND_RULES,
  TOOL_SELECTION_RULES,
  TRADEOFF_RULES,
  UNCERTAINTY_RULES,
  VALUE_LEARNING_RULES,
  VERIFICATION_RULES,
} from "@/services/bot/agent-turn";

describe("shared reasoning: the Auditor gets all ten forms", () => {
  it("lists exactly the ten required forms, by id", () => {
    expect(TEN_REASONING_FORMS.map((form) => form.id)).toEqual([
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

  it("carries every one of the ten forms in the Auditor's prompt", () => {
    const prompt = buildAuditorReasoningPrompt();
    for (const form of TEN_REASONING_FORMS) {
      expect(prompt).toContain(form.marker);
      expect(prompt).toContain(form.text);
    }
  });

  it("also shares the five Frontier 1 forms — none silently dropped", () => {
    expect(FRONTIER_REASONING_FORMS.map((form) => form.id)).toEqual([
      "chained",
      "verification",
      "uncertainty",
      "tradeoff",
      "prediction",
    ]);
    const prompt = buildAuditorReasoningPrompt();
    for (const form of FRONTIER_REASONING_FORMS) {
      expect(prompt).toContain(form.marker);
    }
  });

  it("also shares the learning mechanism, labelled as a mechanism, not a form", () => {
    expect(LEARNING_FORM.id).toBe("learning");
    expect(buildAuditorReasoningPrompt()).toContain(LEARNING_FORM.marker);
  });

  it("shares sixteen blocks in total: 10 forms + 5 Frontier 1 + learning", () => {
    expect(ALL_SHARED_REASONING_FORMS).toHaveLength(16);
    expect(new Set(ALL_SHARED_REASONING_FORMS.map((form) => form.id)).size).toBe(16);
  });

  it("is the same text Abel has — no fork: each shared block equals agent-turn's block", () => {
    const abelBlocks: Record<string, string> = {
      temporal: TEMPORAL_RULES,
      contextual: CONTEXTUAL_RULES,
      causal: CAUSAL_RULES,
      practical: TOOL_SELECTION_RULES,
      "self-correction": SELF_CORRECTION_RULES,
      episodic: EPISODIC_RULES,
      "theory-of-mind": THEORY_OF_MIND_RULES,
      "value-learning": VALUE_LEARNING_RULES,
      consolidation: CONSOLIDATION_RULES,
      restraint: RESTRAINT_RULES,
      chained: CHAINED_REASONING_RULES,
      verification: VERIFICATION_RULES,
      uncertainty: UNCERTAINTY_RULES,
      tradeoff: TRADEOFF_RULES,
      prediction: PREDICTION_RULES,
      learning: LEARNING_RULES,
    };
    for (const form of ALL_SHARED_REASONING_FORMS) {
      expect(form.text).toBe(abelBlocks[form.id]);
    }
  });

  it("resolves every form by id, and nothing else", () => {
    for (const form of ALL_SHARED_REASONING_FORMS) {
      expect(reasoningFormById(form.id)?.name).toBe(form.name);
    }
    expect(reasoningFormById("temporal")?.marker).toContain("TIME:");
  });

  it("reads the Auditor scope overlay FIRST, before the shared blocks", () => {
    const prompt = buildAuditorReasoningPrompt();
    expect(prompt.startsWith(AUDITOR_REASONING_OVERLAY)).toBe(true);
    expect(prompt.indexOf("AUDITOR READING OF THE SHARED REASONING")).toBe(0);
  });

  it("the overlay overrides Abel's write mechanics: flag, never fix; 'cannot verify' when the tool is missing", () => {
    expect(AUDITOR_REASONING_OVERLAY).toMatch(/no write tools/i);
    expect(AUDITOR_REASONING_OVERLAY).toMatch(/never fix (a record|it) yourself/i);
    expect(AUDITOR_REASONING_OVERLAY).toMatch(/FLAG the correction/i);
    expect(AUDITOR_REASONING_OVERLAY).toMatch(/no save_memory/i);
    expect(AUDITOR_REASONING_OVERLAY).toMatch(/cannot verify/i);
    expect(AUDITOR_REASONING_OVERLAY).toMatch(/checks out/i);
    expect(AUDITOR_REASONING_OVERLAY).toMatch(/PHRASING DRIFT/i);
  });

  it("buildSharedReasoningPrompt gives the Auditor its overlay and other bots the shared text", () => {
    expect(buildSharedReasoningPrompt("auditor")).toBe(buildAuditorReasoningPrompt());
    expect(buildSharedReasoningPrompt("abel")).toBe(sharedReasoningText());
    expect(buildSharedReasoningPrompt("abel")).not.toContain("AUDITOR READING");
  });
});
