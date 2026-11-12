// Frontier 2 — the "What I know about you" model: grouping,
// loading, and the shared text rendering.

import { describe, expect, it } from "vitest";
import {
  formatWhatIKnowText,
  groupWhatIKnow,
  type WhatIKnowEntry,
  type WhatIKnowModel,
} from "@/services/bot/what-i-know";

const entry = (id: string, kind: string, content: string): WhatIKnowEntry => ({
  id, kind, content, created_at: "2026-11-10T08:00:00.000Z", valid_to: null, superseded_by: null,
});

describe("groupWhatIKnow", () => {
  it("groups beliefs, preferences, and other — nothing stored is hidden", () => {
    const model = groupWhatIKnow(
      [
        entry("b1", "fact", "Carrier settles Thursdays."),
        entry("b2", "business_fact", "BUSINESS — How this carrier pays | Weekly."),
        entry("b3", "person_profile", "PERSON — Steven | role: truck owner."),
        entry("p1", "instruction", "Always text me before calling."),
        entry("o1", "note", "A scratch note."),
        entry("o2", "expense_hint", "Spent $40 on fuel."),
      ],
      [
        { id: "l1", kind: "learned", summary: "Morning digest flops", situation: "Dropped 3 morning digests.", lesson: "Only suggest a morning digest when he asks.", valence: "hurt", confidence: 0.9, provenance: "model_inferred_unconfirmed", created_at: "2026-11-10T08:00:00.000Z", valid_to: null, superseded_by: null },
      ],
    );
    expect(model.beliefs.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
    expect(model.preferences.map((p) => p.id)).toEqual(["p1"]);
    expect(model.other.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(model.lessons).toHaveLength(1);
    expect(model.lessons[0]!.evidence).toBe("Dropped 3 morning digests.");
  });
});

describe("formatWhatIKnowText", () => {
  it("renders one line per item with evidence, lessons numbered for correct-by-reply", () => {
    const model: WhatIKnowModel = {
      beliefs: [entry("b1", "fact", "Carrier settles Thursdays.")],
      preferences: [entry("p1", "instruction", "Always text me before calling.")],
      other: [],
      lessons: [
        { id: "l1", kind: "learned", summary: "Morning digest flops", situation: "Dropped 3 morning digests.", lesson: "Only suggest a morning digest when he asks.", valence: "hurt", confidence: 0.9, provenance: "model_inferred_unconfirmed", created_at: "2026-11-10T08:00:00.000Z", valid_to: null, superseded_by: null, evidence: "Dropped 3 morning digests." },
      ],
    };
    const text = formatWhatIKnowText(model);
    expect(text).toContain("Beliefs:");
    expect(text).toContain("- [fact] Carrier settles Thursdays.");
    expect(text).toContain("Preferences:");
    expect(text).toContain("1. Only suggest a morning digest when he asks. (from: Dropped 3 morning digests.)");
    expect(text).toContain("tell me which one and what's right");
  });

  it("says plainly when nothing is stored", () => {
    const text = formatWhatIKnowText({ beliefs: [], preferences: [], other: [], lessons: [] });
    expect(text).toContain("Nothing stored yet");
  });
});
