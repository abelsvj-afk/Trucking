import { describe, expect, it } from "vitest";
import { FIGURE_LEFT_OUT_NOTE, UNGROUNDED_FIGURE_REPLY, withoutUngroundedFigures } from "@/services/ai/agent-loop";

describe("an untraceable dollar figure costs its sentence, not the whole answer (owner 2026-11-16)", () => {
  const corpus = "Trip 9918 total 281.18 mi. Pay terms: $0.55 per mile.";

  it("keeps the answer to his note and drops only the sentence with the made-up figure", () => {
    const reply =
      "Got it — the trailer is empty and you're pulling it to the next pickup.\n" +
      "You may drop and hook there; I'll note it on the trip. That trip should pay about $154.00.";
    const out = withoutUngroundedFigures(reply, corpus);
    expect(out).toContain("the trailer is empty");
    expect(out).toContain("drop and hook");
    expect(out).not.toContain("$154.00");
    expect(out).toContain(FIGURE_LEFT_OUT_NOTE);
  });

  it("a figure that IS in his records stays", () => {
    const reply = "Your rate is $0.55 per mile, and the trip is 281.18 miles. Something else costs $99.00.";
    const out = withoutUngroundedFigures(reply, corpus);
    expect(out).toContain("$0.55");
    expect(out).not.toContain("$99.00");
  });

  it("when almost nothing is left, the old refusal stands", () => {
    expect(withoutUngroundedFigures("That's $812.00.", corpus)).toBe(UNGROUNDED_FIGURE_REPLY);
  });
});
