import { describe, expect, it } from "vitest";
import { correctedFields, correctionSummary, correctionWatchoutsBlock } from "@/services/bot/correction-watchouts";
import type { OutcomeRow } from "@/services/bot/learning";

const row = (summary: string, outcome: OutcomeRow["outcome"] = "corrected"): OutcomeRow => ({
  tool_name: "create_load", signature: "create_load", outcome, summary, created_at: "2026-11-16T12:00:00Z",
});

describe("learning from his corrections", () => {
  it("a field fixed twice becomes a watch-out; once is not a pattern", () => {
    const rows = [row(correctionSummary(["trailer_number"])), row(correctionSummary(["trailer_number", "broker_name"])), row(correctionSummary(["delivery_date"]))];
    expect(correctedFields(rows)).toEqual([{ field: "trailer_number", count: 2 }]);
    const block = correctionWatchoutsBlock(rows)!;
    expect(block).toContain("trailer number: corrected 2 times");
    expect(block).toContain("ASK him for that one value");
    expect(block).not.toContain("delivery date");
  });

  it("other outcomes and older-style summaries are not counted; nothing to show = no block", () => {
    expect(correctionWatchoutsBlock([row("Remember: x"), row(correctionSummary(["miles"]), "approved"), row(correctionSummary(["miles"]))])).toBeNull();
  });
});
