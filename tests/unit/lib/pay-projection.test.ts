import { describe, expect, it } from "vitest";
import { formatRange, projectLoad, projectPeriod, weekBounds, type PayTerms, type ProjectableLoad } from "@/lib/pay-projection";

const terms = (mile_basis: PayTerms["mile_basis"]): PayTerms => ({ employer_name: "Acme", rate_cents_per_mile: 55, mile_basis });
const load = (over: Partial<ProjectableLoad> = {}): ProjectableLoad => ({
  id: "L1", origin: "A", destination: "B", status: "confirmed", miles: 1000, loaded_miles: 900, deadhead_miles: 100,
  pickup_date: "2026-11-04", delivery_date: "2026-11-05", ...over,
});

describe("projectLoad - basis pinned", () => {
  it("loaded miles only", () => {
    const p = projectLoad(terms("loaded"), load());
    expect(p).toMatchObject({ kind: "exact", lowCents: 49500, highCents: 49500 });
    expect(p.counted).toContain("900 loaded miles");
  });
  it("all miles = loaded + deadhead", () => {
    expect(projectLoad(terms("all"), load())).toMatchObject({ kind: "exact", lowCents: 55000 });
  });
  it("loaded basis with no loaded figure is 'can't project', never a substituted number", () => {
    const p = projectLoad(terms("loaded"), load({ loaded_miles: null, deadhead_miles: null }));
    expect(p).toMatchObject({ kind: "unavailable", lowCents: null, highCents: null });
    expect(p.note).toMatch(/no loaded-miles figure/);
  });
  it("practical miles are carrier-computed: unavailable", () => {
    expect(projectLoad(terms("practical"), load()).kind).toBe("unavailable");
  });
});

describe("projectLoad - basis NOT set (never guesses)", () => {
  it("shows a RANGE when loaded and all-miles differ, and says why", () => {
    const p = projectLoad(terms(null), load());
    expect(p).toMatchObject({ kind: "range", lowCents: 49500, highCents: 55000 });
    expect(p.note).toMatch(/basis isn't set/);
  });
  it("one mileage figure only: a single number labeled as assumed", () => {
    const p = projectLoad(terms(null), load({ loaded_miles: null, deadhead_miles: null, miles: 1000 }));
    expect(p).toMatchObject({ kind: "assumed", lowCents: 55000, highCents: 55000 });
    expect(p.note).toMatch(/Set which miles are paid/);
  });
  it("no mileage at all: unavailable", () => {
    expect(projectLoad(terms(null), load({ miles: null, loaded_miles: null, deadhead_miles: null })).kind).toBe("unavailable");
  });
  it("money is integer cents (rounding of fractional miles)", () => {
    const p = projectLoad(terms("loaded"), load({ loaded_miles: 900.55 }));
    expect(Number.isInteger(p.lowCents)).toBe(true);
    expect(p.lowCents).toBe(Math.round(55 * 900.55));
  });
});

describe("weekBounds / projectPeriod", () => {
  it("Monday to Sunday containing the date", () => {
    expect(weekBounds("2026-11-05")).toEqual({ start: "2026-11-02", end: "2026-11-08" }); // a Thursday
    expect(weekBounds("2026-11-08")).toEqual({ start: "2026-11-02", end: "2026-11-08" }); // Sunday
    expect(weekBounds("2026-11-02")).toEqual({ start: "2026-11-02", end: "2026-11-08" }); // Monday
  });

  it("adds up as loads are added; drafts/cancelled and other weeks are excluded; unavailable loads are counted, not guessed", () => {
    const loads = [
      load({ id: "a" }),
      load({ id: "b", miles: 500, loaded_miles: 450, deadhead_miles: 50, delivery_date: "2026-11-07" }),
      load({ id: "draft", status: "draft" }),
      load({ id: "old", delivery_date: "2026-10-20", pickup_date: "2026-10-19" }),
      load({ id: "nomiles", miles: null, loaded_miles: null, deadhead_miles: null }),
    ];
    const p = projectPeriod(terms(null), loads, "2026-11-05");
    expect(p.rows.map((r) => r.load.id)).toEqual(["a", "b", "nomiles"]);
    expect(p.lowCents).toBe(49500 + 24750);
    expect(p.highCents).toBe(55000 + 27500);
    expect(p.unavailableCount).toBe(1);
    expect(p.excludedCount).toBe(1);
    expect(p.basisAssumed).toBe(true);
  });

  it("with the basis pinned there is no assumption flag", () => {
    expect(projectPeriod(terms("loaded"), [load()], "2026-11-05").basisAssumed).toBe(false);
  });

  it("formatRange", () => {
    expect(formatRange(100, 100)).toBe("$1.00");
    expect(formatRange(100, 250)).toBe("$1.00 – $2.50");
  });
});
