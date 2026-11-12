// Phase D acceptance (design §5, tests 2-4): code-computed true
// pay - 1099 set-aside and spendable, effective $/mile and $/hour,
// pin reproduction and mismatch, candidate models while unpinned,
// and the weekly report reconciling to the settlement rows to the
// cent (recomputed independently here).

import { describe, expect, it } from "vitest";
import { UNKNOWN_PIN, type PayPin } from "@/services/bot/pay-pin";
import {
  buildWeeklyPayReport,
  candidateModels,
  checkSettlementAgainstPin,
  computeTruePay,
  explainLoadEconomics,
  reproducePayUnderPin,
  type SettlementFigures,
} from "@/services/bot/pay-truth";

const PIN_30_1099: PayPin = {
  model: "percentage_gross",
  rate: 30,
  employment: "1099",
  fuelPaidBy: "owner",
  tollsPaidBy: "driver",
  settlementDay: "Friday",
  taxSetasidePercent: 25,
  source: "test",
  pinnedAt: "2026-11-02",
};

function figures(overrides: Partial<SettlementFigures> = {}): SettlementFigures {
  return {
    issuerName: "Steven's carrier",
    periodStart: "2026-10-26",
    periodEnd: "2026-11-01",
    grossCents: 400_000,
    carrierCutCents: 280_000,
    netToTruckCents: 120_000,
    driverPayCents: 120_000,
    milesTotal: 2_400,
    milesLoaded: 2_000,
    dutyMinutes: 3_000,
    ...overrides,
  };
}

describe("computeTruePay", () => {
  it("1099: set-aside is code-computed at the pin's percent; spendable is pay minus set-aside", () => {
    const truth = computeTruePay(figures(), PIN_30_1099);
    expect(truth.taxSetasideCents).toBe(30_000);
    expect(truth.spendableCents).toBe(90_000);
    expect(truth.effectiveCpmCents).toBe(50); // $1,200 / 2,400 mi
    expect(truth.effectiveHourlyCents).toBe(2_400); // $1,200 / 50 duty hours
    const text = truth.lines.join("\n");
    expect(text).toContain("Tax set-aside at 25%");
    expect(text).toContain("$300.00");
    expect(text).toContain("$0.50/mi");
    expect(text).toContain("$24.00/hr");
  });

  it("W-2: no self-employment set-aside computed (withholding instead)", () => {
    const truth = computeTruePay(figures(), { ...PIN_30_1099, employment: "w2" });
    expect(truth.taxSetasideCents).toBeNull();
    expect(truth.spendableCents).toBe(120_000);
    expect(truth.lines.join("\n")).toContain("withholding");
    expect(truth.lines.join("\n")).not.toContain("Spendable:");
  });

  it("employment unknown: no set-aside invented; the lines say it isn't pinned", () => {
    const truth = computeTruePay(figures(), { ...PIN_30_1099, employment: "UNKNOWN" });
    expect(truth.taxSetasideCents).toBeNull();
    expect(truth.lines.join("\n")).toContain("isn't pinned yet");
  });

  it("missing miles/minutes: those rates are null, never divided by zero or guessed", () => {
    const truth = computeTruePay(figures({ milesTotal: null, dutyMinutes: null }), PIN_30_1099);
    expect(truth.effectiveCpmCents).toBeNull();
    expect(truth.effectiveHourlyCents).toBeNull();
  });
});

describe("pin reproduction + check", () => {
  it("reproduces each model in code", () => {
    expect(reproducePayUnderPin(figures(), PIN_30_1099, 0)).toBe(120_000);
    expect(reproducePayUnderPin(figures(), { ...PIN_30_1099, model: "percentage_net", rate: 50 }, 0)).toBe(60_000);
    expect(reproducePayUnderPin(figures(), { ...PIN_30_1099, model: "cpm_all_miles", rate: 0.5 }, 0)).toBe(120_000);
    expect(reproducePayUnderPin(figures(), { ...PIN_30_1099, model: "cpm_loaded", rate: 0.6 }, 0)).toBe(120_000);
    expect(reproducePayUnderPin(figures(), { ...PIN_30_1099, model: "flat_per_load", rate: 400 }, 3)).toBe(120_000);
    expect(reproducePayUnderPin(figures(), { ...PIN_30_1099, model: "flat_per_load", rate: 400 }, 0)).toBeNull();
    expect(reproducePayUnderPin(figures(), { ...PIN_30_1099, model: "flat_per_day", rate: 200 }, 0)).toBe(140_000); // 7-day period
    expect(reproducePayUnderPin(figures(), UNKNOWN_PIN, 0)).toBeNull();
    expect(reproducePayUnderPin(figures(), { ...PIN_30_1099, rate: null }, 0)).toBeNull();
  });

  it("fits: a settlement matching the pin checks fits", () => {
    expect(checkSettlementAgainstPin(figures(), PIN_30_1099, 0).status).toBe("fits");
  });

  it("mismatch: BOTH figures are shown, never absorbed", () => {
    const check = checkSettlementAgainstPin(figures({ driverPayCents: 100_000 }), PIN_30_1099, 0);
    expect(check.status).toBe("mismatch");
    expect(check.detail).toContain("$1,200.00"); // pin reproduces
    expect(check.detail).toContain("$1,000.00"); // statement paid
  });

  it("unpinned, mixed, and insufficient-data are their own states, not silent passes", () => {
    expect(checkSettlementAgainstPin(figures(), UNKNOWN_PIN, 0).status).toBe("unpinned");
    expect(checkSettlementAgainstPin(figures(), { ...PIN_30_1099, model: "mixed" }, 0).status).toBe("insufficient_data");
    expect(
      checkSettlementAgainstPin(figures({ netToTruckCents: null }), { ...PIN_30_1099, model: "percentage_net" }, 0).status,
    ).toBe("insufficient_data");
  });
});

describe("candidateModels (the un-pinned proposal evidence)", () => {
  it("fits the settlement's math backwards and labels plausibility", () => {
    const candidates = candidateModels(figures(), 3);
    const pct = candidates.find((c) => c.model === "percentage_gross");
    expect(pct?.impliedRate).toBe(30);
    expect(pct?.plausible).toBe(true);
    const cpmAll = candidates.find((c) => c.model === "cpm_all_miles");
    expect(cpmAll?.impliedRate).toBe(0.5);
    const flat = candidates.find((c) => c.model === "flat_per_load");
    expect(flat?.impliedRate).toBe(400);
  });
});

describe("buildWeeklyPayReport", () => {
  const settlements = [
    { ...figures(), pinCheck: "fits" },
    {
      ...figures({
        grossCents: 300_000,
        carrierCutCents: 210_000,
        netToTruckCents: 90_000,
        driverPayCents: 90_000,
        milesTotal: 1_800,
        milesLoaded: 1_500,
        dutyMinutes: 2_400,
      }),
      pinCheck: "fits",
    },
  ];

  it("reconciles to the settlement rows to the cent", () => {
    const report = buildWeeklyPayReport({
      weekLabel: "week of 2026-10-26 to 2026-11-01",
      settlements,
      completedLoads: [],
      pin: PIN_30_1099,
    });
    // Independent recomputation from the raw rows:
    expect(report.figures.grossCents).toBe(400_000 + 300_000);
    expect(report.figures.driverPayCents).toBe(120_000 + 90_000);
    expect(report.figures.carrierCutCents).toBe(280_000 + 210_000);
    expect(report.figures.taxSetasideCents).toBe(Math.round(210_000 * 0.25));
    expect(report.figures.spendableCents).toBe(210_000 - (report.figures.taxSetasideCents ?? 0));
    expect(report.text).toContain("$2,100.00");
    expect(report.text).toContain("Deadhead: 700 of 4200 miles");
  });

  it("surfaces a pin mismatch in the week and labels the own-authority figure an estimate", () => {
    const report = buildWeeklyPayReport({
      weekLabel: "week of 2026-10-26 to 2026-11-01",
      settlements: [{ ...figures(), pinCheck: "mismatch" }],
      completedLoads: [{ origin: "Dallas, TX", destination: "Atlanta, GA", rateCents: 400_000, miles: 2_400 }],
      pin: PIN_30_1099,
    });
    expect(report.text).toContain("did NOT match the pin");
    expect(report.text).toContain("ESTIMATE");
    expect(report.figures.ownAuthorityGrossCents).toBe(400_000);
  });

  it("unpinned week: no single model stated as his; the week's fits are offered instead", () => {
    const report = buildWeeklyPayReport({
      weekLabel: "week of 2026-10-26 to 2026-11-01",
      settlements: [{ ...figures(), pinCheck: "unpinned" }],
      completedLoads: [],
      pin: UNKNOWN_PIN,
    });
    expect(report.text).toContain("still NOT PINNED");
    expect(report.text).toContain("percentage_gross at 30%");
  });

  it("empty week says so plainly", () => {
    const report = buildWeeklyPayReport({
      weekLabel: "week of 2026-10-26 to 2026-11-01",
      settlements: [],
      completedLoads: [],
      pin: PIN_30_1099,
    });
    expect(report.figures.settlementCount).toBe(0);
    expect(report.text).toContain("No settlement landed this week");
  });
});

describe("explainLoadEconomics", () => {
  it("no actuals and no pin: the carrier cut is the labeled general band, never a fact about this carrier", () => {
    const walk = explainLoadEconomics({
      origin: "Dallas, TX",
      destination: "Atlanta, GA",
      grossCents: 200_000,
      miles: 1_000,
      actualPayCents: null,
      actualCarrierCutCents: null,
      pin: UNKNOWN_PIN,
    });
    const text = walk.lines.join("\n");
    expect(text).toContain("typical lease-on cut is 20-30%");
    expect(text).toContain("NOT this carrier's number");
    expect(text).not.toContain("The carrier kept");
    expect(text).toContain("own authority, the full $2,000.00");
  });

  it("pinned: his share comes from the pin and is labeled as the pin's math", () => {
    const walk = explainLoadEconomics({
      origin: "Dallas, TX",
      destination: "Atlanta, GA",
      grossCents: 200_000,
      miles: 1_000,
      actualPayCents: null,
      actualCarrierCutCents: null,
      pin: PIN_30_1099,
    });
    expect(walk.lines.join("\n")).toContain("Under your pin (percentage_gross), your pay on a load like this works out to $600.00");
  });
});
