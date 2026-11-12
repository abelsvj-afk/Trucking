// Frontier 2 — per-kind half-lives (plan: episodes ~7d,
// preferences ~90d, facts 365d, constraints ∞). Decay ranks,
// never deletes. Pure — no database, no model.

import { describe, expect, it } from "vitest";
import {
  applyHalfLife,
  halfLifeWeight,
  memoryKindHalfLifeMs,
  rerankWithHalfLife,
  type HalfLifeRow,
} from "@/services/bot/half-life";

const DAY = 86_400_000;

describe("halfLifeWeight", () => {
  it("an episode halves every ~7 days", () => {
    expect(halfLifeWeight("episode", 0)).toBe(1);
    expect(halfLifeWeight("episode", 7 * DAY)).toBeCloseTo(0.5, 5);
    expect(halfLifeWeight("episode", 30 * DAY)).toBeLessThan(0.06);
  });
  it("a preference halves every ~90 days", () => {
    expect(halfLifeWeight("preference", 90 * DAY)).toBeCloseTo(0.5, 5);
    expect(halfLifeWeight("preference", 30 * DAY)).toBeGreaterThan(0.7);
  });
  it("a fact halves every 365 days", () => {
    expect(halfLifeWeight("fact", 365 * DAY)).toBeCloseTo(0.5, 5);
    expect(halfLifeWeight("fact", 30 * DAY)).toBeGreaterThan(0.9);
  });
  it("a constraint never decays", () => {
    expect(halfLifeWeight("constraint", 10 * 365 * DAY)).toBe(1);
  });
  it("negative ages and unknown kinds do not explode", () => {
    expect(halfLifeWeight("episode", -1000)).toBe(1);
    expect(halfLifeWeight("mystery" as never, 30 * DAY)).toBeGreaterThan(0);
  });
});

describe("memoryKindHalfLifeMs", () => {
  it("agent_episodes rows count as episodes; bot_memories kinds map by role", () => {
    // fact -> 365d; instruction / person_profile / business_fact ->
    // constraints (never decay). A preference is a fact row whose
    // content IS a preference — no reliable marker exists in the
    // store, so fact stays 365d (documented in the module).
    expect(memoryKindHalfLifeMs("episode")).toBe(7 * DAY);
    expect(memoryKindHalfLifeMs("fact")).toBe(365 * DAY);
    expect(memoryKindHalfLifeMs("instruction")).toBe(Number.POSITIVE_INFINITY);
    expect(memoryKindHalfLifeMs("person_profile")).toBe(Number.POSITIVE_INFINITY);
    expect(memoryKindHalfLifeMs("business_fact")).toBe(Number.POSITIVE_INFINITY);
    expect(memoryKindHalfLifeMs("note")).toBe(7 * DAY);
    expect(memoryKindHalfLifeMs("expense_hint")).toBe(7 * DAY);
  });
});

describe("applyHalfLife / rerankWithHalfLife (F2-C)", () => {
  it("a 30-day-old episode ranks below a fresh fact of equal similarity", () => {
    const now = new Date("2026-11-11T12:00:00Z").getTime();
    const rows: HalfLifeRow[] = [
      { id: "old-episode", kind: "episode", created_at: new Date(now - 30 * DAY).toISOString(), score: 0.5 },
      { id: "fresh-fact", kind: "fact", created_at: new Date(now).toISOString(), score: 0.5 },
    ];
    const ranked = rerankWithHalfLife(rows, now);
    expect(ranked[0]!.id).toBe("fresh-fact");
    expect(ranked[1]!.id).toBe("old-episode");
    // The decay is a multiplier on the score, never a deletion.
    expect(ranked).toHaveLength(2);
    expect(ranked[1]!.decayedScore).toBeLessThan(ranked[1]!.score);
    expect(ranked[0]!.decayedScore).toBeCloseTo(0.5, 5);
  });
  it("a constraint outranks an equally similar old episode (it never decays)", () => {
    const now = Date.now();
    const rows: HalfLifeRow[] = [
      { id: "old-episode", kind: "episode", created_at: new Date(now - 30 * DAY).toISOString(), score: 0.4 },
      { id: "old-constraint", kind: "constraint", created_at: new Date(now - 300 * DAY).toISOString(), score: 0.4 },
    ];
    const ranked = rerankWithHalfLife(rows, now);
    expect(ranked[0]!.id).toBe("old-constraint");
    expect(ranked[0]!.decayedScore).toBe(0.4);
    expect(applyHalfLife(0.4, "constraint", 300 * DAY)).toBe(0.4);
  });
  it("ties keep their input order (stable, deterministic)", () => {
    const now = Date.now();
    const rows: HalfLifeRow[] = [
      { id: "a", kind: "fact", created_at: new Date(now).toISOString(), score: 0.5 },
      { id: "b", kind: "fact", created_at: new Date(now).toISOString(), score: 0.5 },
    ];
    expect(rerankWithHalfLife(rows, now).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
