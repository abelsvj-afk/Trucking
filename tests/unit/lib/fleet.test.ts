// Fleet learning (owner 2026-11-07): regions, the preference catalog, learning from decisions, load recommendations
// that balance money and comfort, and home time.

import { describe, expect, it } from "vitest";
import { normalizePlace, normalizeState, regionOfState, stateInPlace } from "@/lib/fleet/regions";
import { describePreference, parsePreference } from "@/lib/fleet/preferences";
import { learnFromDecisions, type DecisionFeatures } from "@/lib/fleet/learn-decisions";
import { formatRanking, rankCandidates, scoreCandidate, weights, type CandidateLoad, type DriverProfile } from "@/lib/fleet/recommend";
import { formatHomeTime, homeTimeStatus } from "@/lib/fleet/home-time";

describe("regions", () => {
  it("places states, names and phrases; refuses what it can't place", () => {
    expect(normalizeState("fl")).toBe("FL");
    expect(normalizeState("Florida")).toBe("FL");
    expect(normalizeState("New York")).toBe("NY");
    expect(normalizeState("ZZ")).toBeNull();
    expect(regionOfState("GA")).toBe("southeast");
    expect(regionOfState("NJ")).toBe("northeast");
    expect(regionOfState("TX")).toBe("southwest");
    expect(normalizePlace("the Northeast")).toBe("northeast");
    expect(normalizePlace("the south")).toBe("southeast");
    expect(normalizePlace("Ohio")).toBe("OH");
    expect(normalizePlace("narnia")).toBeNull();
  });
  it("stateInPlace works for both regions and single states", () => {
    expect(stateInPlace("NY", "northeast")).toBe(true);
    expect(stateInPlace("NY", "NY")).toBe(true);
    expect(stateInPlace("FL", "northeast")).toBe(false);
    expect(stateInPlace(null, "northeast")).toBe(false);
  });
});

describe("preference catalog", () => {
  it("validates and normalises values per key", () => {
    expect(parsePreference("driver", "home_base", { city: "Macon", state: "georgia" })).toEqual({ ok: true, value: { city: "Macon", state: "GA" } });
    expect(parsePreference("driver", "avoid_regions", ["the Northeast", "Texas"])).toEqual({ ok: true, value: ["northeast", "TX"] });
    expect(parsePreference("driver", "home_time", { every_days: 14, min_days: 2 })).toEqual({ ok: true, value: { every_days: 14, min_days: 2 } });
    expect(parsePreference("owner", "money_vs_comfort", 0.7)).toEqual({ ok: true, value: 0.7 });
    expect(parsePreference("owner", "news_interest:tech", 0.9)).toEqual({ ok: true, value: 0.9 });
  });
  it("refuses bad values and unknown keys in plain words", () => {
    for (const [subject, key, value] of [
      ["driver", "avoid_regions", ["narnia"]], ["driver", "last_home_date", "yesterday"], ["driver", "min_cents_per_mile", -5],
      ["driver", "home_time", { every_days: 0, min_days: 1 }], ["owner", "money_vs_comfort", 1.5], ["owner", "news_interest:cooking", 0.5],
      ["driver", "favorite_color", "red"], ["owner", "home_base", {}],
    ] as const) {
      const r = parsePreference(subject, key, value);
      expect(r.ok).toBe(false);
    }
    const unknown = parsePreference("driver", "favorite_color", "red");
    expect(!unknown.ok && unknown.error).toMatch(/not a driver preference I keep/);
  });
  it("describes preferences in words", () => {
    expect(describePreference("home_time", { every_days: 14, min_days: 2 })).toBe("wants home every 14 days for 2 days");
    expect(describePreference("min_cents_per_mile", 190)).toBe("minimum $1.90/mile");
    expect(describePreference("money_vs_comfort", 0.7)).toBe("weighs money 70% / comfort 30%");
    expect(describePreference("avoid_regions", ["northeast"])).toBe("avoids northeast");
  });
});

describe("learnFromDecisions", () => {
  const d = (decision: "taken" | "passed", dest: string, miles = 500, rate = 120000, deadhead = 0): DecisionFeatures => ({ decision, destination_state: dest, miles, rate_cents: rate, deadhead_miles: deadhead });
  it("needs enough decisions - three passes are not a pattern", () => {
    expect(learnFromDecisions([d("passed", "NY"), d("passed", "NJ"), d("passed", "PA")])).toEqual([]);
  });
  it("a region he keeps passing becomes an 'avoid' candidate with evidence and confidence", () => {
    const cands = learnFromDecisions([d("passed", "NY"), d("passed", "NJ"), d("passed", "PA"), d("passed", "MA"), d("taken", "CT"), d("taken", "FL"), d("taken", "GA")]);
    const avoid = cands.find((c) => c.key === "avoid_regions")!;
    expect(avoid.value).toEqual(["northeast"]);
    expect(avoid.evidence).toBe("passed 4 of 5 loads going to the northeast");
    expect(avoid.confidence).toBeGreaterThan(0.3);
    expect(avoid.confidence).toBeLessThanOrEqual(0.95);
  });
  it("a region he reliably takes becomes a 'prefer' candidate", () => {
    const cands = learnFromDecisions(Array.from({ length: 5 }, () => d("taken", "GA")));
    expect(cands.find((c) => c.key === "preferred_regions")!.value).toEqual(["southeast"]);
  });
  it("long trips he keeps passing become a max-miles candidate; short ones a min-miles candidate", () => {
    const long = learnFromDecisions([d("passed", "OH", 1100), d("passed", "IL", 950), d("passed", "IN", 900), d("passed", "MI", 1200), d("taken", "OH", 1000)]);
    expect(long.find((c) => c.key === "max_trip_miles")).toMatchObject({ value: 800, evidence: "passed 4 of 5 loads over 800 miles" });
    const short = learnFromDecisions([d("passed", "OH", 120), d("passed", "IL", 200), d("passed", "IN", 90), d("passed", "MI", 250)]);
    expect(short.find((c) => c.key === "min_trip_miles")).toMatchObject({ value: 300 });
  });
  it("learns the lowest rate he accepts when he passed loads paying less", () => {
    const cands = learnFromDecisions([
      d("taken", "GA", 500, 100000), d("taken", "FL", 500, 110000), d("taken", "AL", 500, 120000), // 200 / 220 / 240 per mile
      d("passed", "GA", 500, 80000), d("passed", "FL", 500, 85000), d("passed", "AL", 500, 90000), // 160 / 170 / 180
    ]);
    const min = cands.find((c) => c.key === "min_cents_per_mile")!;
    expect(min.value).toBe(200);
    expect(min.evidence).toBe("the lowest rate he has taken is $2.00/mile, and he passed 3 loads paying less");
  });
  it("loads with no features contribute nothing and never crash", () => {
    expect(learnFromDecisions([{ decision: "passed" }, { decision: "taken" }, { decision: "passed" }, { decision: "passed" }])).toEqual([]);
  });
});

describe("recommendations balance money, comfort and home time", () => {
  const profile: DriverProfile = { homeState: "GA", preferredRegions: ["southeast"], avoidRegions: ["northeast"], minCentsPerMile: 200, maxTripMiles: 900 };
  const load = (id: string, dest: string, miles: number, rate: number, deadhead = 0): CandidateLoad => ({ id, label: id, destination_state: dest, miles, rate_cents: rate, deadhead_miles: deadhead });

  it("weights always total 100 and the dial moves money up and comfort down", () => {
    for (const m of [0, 0.25, 0.5, 0.75, 1]) {
      const w = weights(m);
      expect(w.money + w.comfort + w.home).toBe(100);
    }
    expect(weights(1).money).toBeGreaterThan(weights(0).money);
    expect(weights(1).comfort).toBeLessThan(weights(0).comfort);
    expect(weights(Number.NaN).money).toBe(weights(0.5).money);
  });
  it("a well-paid load to a preferred region is a good fit; the reasons say why", () => {
    const s = scoreCandidate(load("A", "FL", 600, 144000), profile, { moneyVsComfort: 0.5 }); // $2.40/mi
    expect(s.verdict).toBe("good fit");
    expect(s.conflicts).toEqual([]);
    expect(s.factors.find((f) => f.name === "money")!.reasons.join(" ")).toContain("$2.40/mile");
    expect(s.factors.find((f) => f.name === "comfort")!.reasons.join(" ")).toContain("prefers");
  });
  it("a load into a region he avoids is a CONFLICT even when it pays well - never silently ranked away", () => {
    const s = scoreCandidate(load("B", "NY", 600, 180000), profile, { moneyVsComfort: 0.9 }); // $3.00/mi, money-heavy dial
    expect(s.verdict).toBe("conflicts with his preferences");
    expect(s.conflicts.join(" ")).toMatch(/goes to NY, which he avoids/);
    expect(s.factors.find((f) => f.name === "comfort")!.points).toBe(0);
  });
  it("deadhead counts as miles driven, and a rate under his minimum is flagged", () => {
    const s = scoreCandidate(load("C", "FL", 500, 110000, 150), profile, { moneyVsComfort: 0.5 }); // 1100/650 = $1.69/mi
    expect(s.factors.find((f) => f.name === "money")!.reasons.join(" ")).toContain("counting 150 deadhead miles");
    expect(s.conflicts.join(" ")).toMatch(/below his \$2\.00 minimum/);
  });
  it("his own lane history beats a generic minimum as the yardstick", () => {
    const lane = (c: CandidateLoad) => (c.id === "L" ? 300 : null);
    const strong = scoreCandidate(load("L", "FL", 500, 125000), profile, { moneyVsComfort: 0.5, laneAvgCentsPerMile: lane }); // $2.50 vs lane $3.00
    expect(strong.factors[0]!.reasons.join(" ")).toContain("his own average on this lane is $3.00/mile");
    const plain = scoreCandidate(load("P", "FL", 500, 125000), profile, { moneyVsComfort: 0.5 });
    expect(plain.factors[0]!.points).toBeGreaterThan(strong.factors[0]!.points); // $2.50 looks better against a $2.00 minimum than a $3.00 lane
  });
  it("when he is due home, a load ending at home beats one that takes him away", () => {
    const home = scoreCandidate(load("H", "GA", 400, 100000), profile, { moneyVsComfort: 0.5, homeDueInDays: 1 });
    const away = scoreCandidate(load("W", "TX", 400, 100000), profile, { moneyVsComfort: 0.5, homeDueInDays: 1 });
    expect(home.factors.find((f) => f.name === "home time")!.points).toBeGreaterThan(away.factors.find((f) => f.name === "home time")!.points);
    expect(away.conflicts.join(" ")).toMatch(/due home and this takes him to TX/);
    expect(home.total).toBeGreaterThan(away.total);
  });
  it("missing information scores neutral and says what to ask for - it never invents a number", () => {
    const s = scoreCandidate({ id: "X", label: "X" }, profile, { moneyVsComfort: 0.5 });
    expect(s.factors[0]!.reasons.join(" ")).toMatch(/no rate or miles given/);
    expect(s.total).toBeGreaterThan(0);
  });
  it("the dial changes the order: money-heavy favours the higher-paying load, comfort-heavy the preferred region", () => {
    const rich = load("rich", "OH", 600, 190000); // $3.17/mi, neutral region
    const cozy = load("cozy", "FL", 600, 125000); // $2.08/mi, preferred region
    const money = rankCandidates([rich, cozy], profile, { moneyVsComfort: 1 })[0]!.candidate.id;
    const comfort = rankCandidates([rich, cozy], profile, { moneyVsComfort: 0 })[0]!.candidate.id;
    expect(money).toBe("rich");
    expect(comfort).toBe("cozy");
  });
  it("formats the ranking with weights, points per factor and conflicts", () => {
    const text = formatRanking(rankCandidates([load("A", "FL", 600, 144000), load("B", "NY", 600, 180000)], profile, { moneyVsComfort: 0.5 }), 0.5);
    expect(text).toContain("Weights: money 40, comfort 35, home time 25");
    expect(text).toMatch(/1\. ✅ A - \d+\/100, good fit/);
    expect(text).toMatch(/⚠️ goes to NY, which he avoids/);
    expect(formatRanking([], 0.5)).toBe("No candidate loads to compare.");
  });
});

describe("home time", () => {
  const TODAY = "2026-11-07";
  const booked = [
    { origin: "Macon, GA", destination: "Tampa, FL", destination_state: "FL", pickup_date: "2026-11-08", delivery_date: "2026-11-09" },
    { origin: "Tampa, FL", destination: "Macon, GA", destination_state: "GA", pickup_date: "2026-11-10", delivery_date: "2026-11-11" },
    { origin: "Macon, GA", destination: "Dallas, TX", destination_state: "TX", pickup_date: "2026-11-12", delivery_date: "2026-11-16" },
  ];
  it("computes days out, the due date and urgency from the last home date and the agreed rhythm", () => {
    const s = homeTimeStatus({ today: TODAY, lastHomeDate: "2026-10-27", everyDays: 14, minDays: 2, homeState: "GA", booked });
    expect(s).toMatchObject({ daysOut: 11, dueDate: "2026-11-10", daysUntilDue: 3, level: "soon" });
  });
  it("finds the loads that end at home and the loads that run past the due date", () => {
    const s = homeTimeStatus({ today: TODAY, lastHomeDate: "2026-10-27", everyDays: 14, homeState: "GA", booked });
    expect(s.windows).toEqual(["Tampa, FL → Macon, GA (delivers 2026-11-11)"]);
    expect(s.runPastDue).toEqual(["Tampa, FL → Macon, GA (delivers 2026-11-11)", "Macon, GA → Dallas, TX (delivers 2026-11-16)"]);
  });
  it("levels: fine, soon, due, overdue", () => {
    const at = (today: string) => homeTimeStatus({ today, lastHomeDate: "2026-10-27", everyDays: 14, booked: [] }).level;
    expect(at("2026-10-30")).toBe("fine");
    expect(at("2026-11-07")).toBe("soon");
    expect(at("2026-11-10")).toBe("due");
    expect(at("2026-11-12")).toBe("overdue");
  });
  it("without a last-home date or rhythm it says what is missing instead of guessing", () => {
    const s = homeTimeStatus({ today: TODAY, booked: [] });
    expect(s.level).toBe("unknown");
    expect(s.notes.join(" ")).toMatch(/no last-home date/);
    expect(formatHomeTime("Dee", s)).toMatch(/can't judge home time yet/);
  });
  it("words it for the owner, including the warning and the home window", () => {
    const s = homeTimeStatus({ today: TODAY, lastHomeDate: "2026-10-27", everyDays: 14, minDays: 2, homeState: "GA", booked });
    const text = formatHomeTime("Dee", s, 2);
    expect(text).toContain("🟡 Dee: out 11 days, home time due in 3 days (Tuesday, Nov 10, 2026), for 2 days.");
    expect(text).toContain("⚠️ Booked past the due date");
    expect(text).toContain("🏠 Loads that end at home: Tampa, FL → Macon, GA");
  });
});
