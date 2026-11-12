// Frontier 2-A — the annoyance signal: how much he has been
// turning down one kind of suggestion lately. Pure — computed in
// code from bot_proposal_outcomes rows, never a model judgment.

import { describe, expect, it } from "vitest";
import { annoyanceSignal, type OutcomeRow } from "@/services/bot/annoyance";
import type { Outcome } from "@/services/bot/learning";

const NOW = new Date("2026-11-11T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const row = (signature: string, outcome: Outcome, days = 1): OutcomeRow => ({
  tool_name: signature.split("/")[0]!,
  signature,
  outcome,
  summary: "s",
  created_at: daysAgo(days),
});
const many = (signature: string, outcome: Outcome, n: number, days = 1) =>
  Array.from({ length: n }, (_, i) => row(signature, outcome, days + i));

describe("annoyanceSignal (F2-A)", () => {
  it("is 0 for a first-time category with no history", () => {
    expect(annoyanceSignal("digest/morning", [], NOW)).toBe(0);
    expect(annoyanceSignal("digest/morning", many("digest/evening", "dropped", 5), NOW)).toBe(0);
  });
  it("is measurably above 0 after 3 declined in-window rows", () => {
    const before = annoyanceSignal("digest/morning", [], NOW);
    const after = annoyanceSignal("digest/morning", many("digest/morning", "dropped", 3), NOW);
    expect(before).toBe(0);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeCloseTo(1, 5);
  });
  it("needs at least 3 declines — 1 or 2 drops are not a pattern yet", () => {
    expect(annoyanceSignal("digest/morning", many("digest/morning", "dropped", 2), NOW)).toBe(0);
  });
  it("approvals pull it down; corrected counts as declined, like learning.ts", () => {
    const rows = [
      ...many("digest/morning", "dropped", 3),
      ...many("digest/morning", "approved", 3),
    ];
    const signal = annoyanceSignal("digest/morning", rows, NOW);
    expect(signal).toBeGreaterThan(0);
    expect(signal).toBeLessThan(1);
    const corrected = annoyanceSignal(
      "digest/morning",
      [...many("digest/morning", "corrected", 3)],
      NOW,
    );
    expect(corrected).toBeGreaterThan(0);
  });
  it("ignores answers older than 90 days and weights recent ones double", () => {
    expect(annoyanceSignal("digest/morning", many("digest/morning", "dropped", 5, 100), NOW)).toBe(0);
    // 3 recent drops (weight 2) + 3 old drops (weight 1, 60d): all
    // in-window, so the signal stays 1 — but drop the recent ones
    // and only old drops remain: still > 0, just weaker weight.
    const oldOnly = annoyanceSignal("digest/morning", many("digest/morning", "dropped", 3, 60), NOW);
    expect(oldOnly).toBeGreaterThan(0);
  });
  it("neutral outcomes (expired, failed, replaced) never count", () => {
    const rows = [
      ...many("digest/morning", "expired", 5),
      ...many("digest/morning", "failed", 2),
    ];
    expect(annoyanceSignal("digest/morning", rows, NOW)).toBe(0);
  });
});
