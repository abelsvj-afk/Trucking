// Learning from his answers (owner approved 2026-11-07): computed in code from his real approvals and drops.

import { describe, expect, it } from "vitest";
import {
  labelOf, learningBlock, learningReport, readyLessons, riskNote, signatureOf, summarizeOutcomes,
  type Outcome, type OutcomeRow,
} from "@/services/bot/learning";

const NOW = new Date("2026-11-07T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const row = (signature: string, outcome: Outcome, days = 1): OutcomeRow => ({ tool_name: signature.split("/")[0]!, signature, outcome, summary: "s", created_at: daysAgo(days) });
const many = (signature: string, outcome: Outcome, n: number, days = 1) => Array.from({ length: n }, (_, i) => row(signature, outcome, days + i));

describe("signatureOf / labelOf", () => {
  it("expenses are judged by category, memories by kind, everything else by tool", () => {
    expect(signatureOf("create_expense", { category: "Fuel" })).toBe("create_expense/fuel");
    expect(signatureOf("create_expense", {})).toBe("create_expense");
    expect(signatureOf("save_memory", { kind: "person_profile" })).toBe("save_memory/person_profile");
    expect(signatureOf("update_load", { load_id: "x" })).toBe("update_load");
  });
  it("labels read in plain words", () => {
    expect(labelOf("create_expense/fuel")).toBe("new expense (fuel) suggestions");
    expect(labelOf("update_load")).toBe("changes to load suggestions");
  });
});

describe("summarizeOutcomes", () => {
  it("counts approvals and declines (dropped + corrected); neutral outcomes never count", () => {
    const stats = summarizeOutcomes(
      [...many("create_expense/fuel", "dropped", 3), row("create_expense/fuel", "approved"), row("create_expense/fuel", "expired"), row("create_expense/fuel", "failed"), row("create_expense/fuel", "replaced"), row("create_expense/fuel", "corrected")],
      NOW,
    );
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ signature: "create_expense/fuel", answered: 5, approved: 1, declined: 4 });
  });
  it("ignores answers older than 90 days and weights recent answers double", () => {
    const old = summarizeOutcomes(many("a", "dropped", 5, 100), NOW);
    expect(old).toEqual([]);
    // 2 recent approvals (weight 2 each = 4) vs 2 old drops (weight 1 each = 2): decline rate 2/6
    const s = summarizeOutcomes([row("a", "approved", 1), row("a", "approved", 2), row("a", "dropped", 60), row("a", "dropped", 70)], NOW)[0]!;
    expect(s.declineRate).toBeCloseTo(2 / 6, 5);
  });
  it("sorts the most-answered signature first", () => {
    const stats = summarizeOutcomes([...many("a", "approved", 2), ...many("b", "approved", 5)], NOW);
    expect(stats.map((s) => s.signature)).toEqual(["b", "a"]);
  });
});

describe("riskNote", () => {
  it("flags a new suggestion he mostly turns down, in words, with the counts", () => {
    const stats = summarizeOutcomes([...many("create_expense/fuel", "dropped", 4), row("create_expense/fuel", "approved")], NOW);
    expect(riskNote("create_expense/fuel", stats)).toBe("🤔 You've turned down 4 of the last 5 new expense (fuel) suggestions - still want this one?");
  });
  it("says nothing with too few answers or when he usually approves", () => {
    expect(riskNote("a", summarizeOutcomes(many("a", "dropped", 2), NOW))).toBeNull();
    expect(riskNote("a", summarizeOutcomes([...many("a", "approved", 6), row("a", "dropped")], NOW))).toBeNull();
    expect(riskNote("never-seen", [])).toBeNull();
  });
});

describe("lessons", () => {
  const stats = summarizeOutcomes([...many("create_expense/fuel", "dropped", 4), row("create_expense/fuel", "approved")], NOW);
  it("a clear pattern becomes a lesson to PROPOSE, carrying its pattern marker", () => {
    const [l] = readyLessons(stats, []);
    expect(l!.signature).toBe("create_expense/fuel");
    expect(l!.text).toMatch(/^Lesson learned from his answers: he usually turns down new expense \(fuel\) suggestions \(4 of 5\)/);
    expect(l!.text).toContain("(pattern: create_expense/fuel)");
  });
  it("is never proposed twice - an existing lesson with the same pattern suppresses it", () => {
    expect(readyLessons(stats, ["Lesson learned ... (pattern: create_expense/fuel)"])).toEqual([]);
  });
  it("no lesson without enough answers or a clear pattern", () => {
    expect(readyLessons(summarizeOutcomes(many("a", "dropped", 2), NOW), [])).toEqual([]);
    expect(readyLessons(summarizeOutcomes([...many("a", "approved", 3), ...many("a", "dropped", 2)], NOW), [])).toEqual([]);
  });
});

describe("what the model and the report see", () => {
  const stats = summarizeOutcomes([...many("create_expense/fuel", "dropped", 4), row("create_expense/fuel", "approved"), ...many("update_load", "approved", 4)], NOW);
  it("the context block is computed facts plus any ready lesson, and keeps approval mandatory", () => {
    const block = learningBlock(stats, readyLessons(stats, []))!;
    expect(block).toContain("computed from his real approvals and drops");
    expect(block).toContain("new expense (fuel) suggestions: approved 1, turned down 4");
    expect(block).toContain("LESSON READY");
    expect(block).toContain("never stop asking for approval on writes");
  });
  it("no block when there is nothing meaningful", () => {
    expect(learningBlock([], [])).toBeNull();
    expect(learningBlock(summarizeOutcomes(many("a", "approved", 2), NOW), [])).toBeNull();
  });
  it("the report is honest about an empty log and about lessons not yet earned", () => {
    expect(learningReport([], [])).toMatch(/No answers logged yet/);
    expect(learningReport(summarizeOutcomes(many("a", "approved", 3), NOW), [])).toMatch(/No lesson has crossed the bar yet/);
    expect(learningReport(stats, readyLessons(stats, []))).toMatch(/Lessons ready to propose: new expense \(fuel\) suggestions/);
  });
});
