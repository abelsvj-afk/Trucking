// Abel Job Brain (§11). The pay advisor: CODE does the math. These
// tests pin the conversions that make offers comparable - effective
// CPM on ALL miles (the loaded-only trap), percentage math, the
// W2<->1099 payroll-tax adjustment - and the band verdicts, using
// the statutory rates restated here independently (SE tax 15.3% on
// 92.35% of net earnings; employee FICA 7.65%).

import { describe, expect, it } from "vitest";
import { evaluatePayOffer, formatPayEvaluation } from "@/services/bot/pay-advisor";

const SE_EFFECTIVE = 0.153 * 0.9235;
const FICA = 0.0765;

describe("evaluatePayOffer", () => {
  it("grades a fair percentage-of-gross offer and computes every comparable", () => {
    const evaluation = evaluatePayOffer({
      structure: "percentage_gross",
      percentage: 25,
      load_gross_dollars: 6000,
      loaded_miles: 2400,
      empty_miles: 300,
      days_on_load: 4,
      employment: "w2",
      fuel_paid_by: "owner",
      detention_terms_known: true,
    });
    expect(evaluation.totalPayDollars).toBe(1500);
    expect(evaluation.effectiveCpmAllMiles).toBe(0.56); // 1500 / 2700
    expect(evaluation.weeklyGrossDollars).toBe(2625); // 1500 * (7/4)
    expect(evaluation.percentageOfGross).toBe(25);
    expect(evaluation.w2EquivalentDollars).toBe(1500);
    // A 1099 version of the same money must pay MORE to match, taxes only.
    expect(evaluation.matching1099Dollars).toBe(
      Math.round(((1500 * (1 - FICA)) / (1 - SE_EFFECTIVE)) * 100) / 100,
    );
    expect(evaluation.verdict).toBe("fair");
    // Fuel is settled (owner pays) and detention is known - neither question appears.
    expect(evaluation.questionsThatChangeTheAnswer.join(" ")).not.toMatch(/who pays for fuel/i);
  });

  it("exposes the loaded-only CPM trap: unpaid empty miles drag the effective rate to weak", () => {
    const evaluation = evaluatePayOffer({
      structure: "cpm_loaded_only",
      cpm_dollars: 0.6,
      loaded_miles: 1800,
      empty_miles: 450,
      loads_per_week: 1,
      employment: "w2",
      fuel_paid_by: "owner",
      detention_terms_known: true,
    });
    expect(evaluation.totalPayDollars).toBe(1080);
    expect(evaluation.effectiveCpmAllMiles).toBe(0.48); // 1080 / 2250 - below the 0.55 weak line
    expect(evaluation.verdict).toBe("weak");
    expect(evaluation.reasons.join(" ")).toMatch(/empty miles unpaid/);
  });

  it("grades a strong all-miles CPM offer strong on both metrics", () => {
    const evaluation = evaluatePayOffer({
      structure: "cpm_all_miles",
      cpm_dollars: 0.7,
      loaded_miles: 2300,
      empty_miles: 200,
      days_on_load: 5,
      employment: "w2",
      fuel_paid_by: "owner",
      detention_terms_known: true,
    });
    expect(evaluation.totalPayDollars).toBe(1750);
    expect(evaluation.effectiveCpmAllMiles).toBe(0.7);
    expect(evaluation.weeklyGrossDollars).toBe(2450);
    expect(evaluation.verdict).toBe("strong");
  });

  it("converts a 1099 offer DOWN to its W2 equivalent by the payroll-tax difference", () => {
    const evaluation = evaluatePayOffer({
      structure: "percentage_gross",
      percentage: 25,
      load_gross_dollars: 6000,
      loaded_miles: 2400,
      empty_miles: 300,
      employment: "1099",
      fuel_paid_by: "owner",
      detention_terms_known: true,
    });
    expect(evaluation.totalPayDollars).toBe(1500);
    expect(evaluation.w2EquivalentDollars).toBe(
      Math.round(((1500 * (1 - SE_EFFECTIVE)) / (1 - FICA)) * 100) / 100,
    );
    expect(evaluation.w2EquivalentDollars!).toBeLessThan(1500);
    expect(evaluation.matching1099Dollars).toBe(1500);
  });

  it("refuses to grade a flat-per-day offer with no days - incomplete, asks for the missing number", () => {
    const evaluation = evaluatePayOffer({
      structure: "flat_per_day",
      flat_dollars: 300,
      loaded_miles: 500,
    });
    expect(evaluation.verdict).toBe("incomplete");
    expect(evaluation.totalPayDollars).toBeNull();
    expect(evaluation.questionsThatChangeTheAnswer.join(" ")).toMatch(/days/);
  });

  it("asks the net-deduction and fuel questions when they are unanswered", () => {
    const evaluation = evaluatePayOffer({
      structure: "percentage_net",
      percentage: 35,
      load_gross_dollars: 4000,
      loaded_miles: 1500,
      empty_miles: 100,
    });
    const questions = evaluation.questionsThatChangeTheAnswer.join(" ");
    expect(questions).toMatch(/deducted before your cut/);
    expect(questions).toMatch(/Who pays for fuel/);
    expect(questions).toMatch(/W2 or 1099/);
    // The headline 35% cannot hide the net warning.
    expect(evaluation.reasons.join(" ")).toMatch(/only as good as the deduction list/);
  });

  it("flags driver-paid fuel in the reasons, not just the questions", () => {
    const evaluation = evaluatePayOffer({
      structure: "cpm_all_miles",
      cpm_dollars: 0.65,
      loaded_miles: 1000,
      empty_miles: 0,
      employment: "w2",
      fuel_paid_by: "driver",
      detention_terms_known: true,
    });
    expect(evaluation.reasons.join(" ")).toMatch(/paying for fuel on someone else's truck/);
  });

  it("formats a grounded tool result carrying every figure", () => {
    const text = formatPayEvaluation(
      evaluatePayOffer({
        structure: "percentage_gross",
        percentage: 25,
        load_gross_dollars: 6000,
        loaded_miles: 2400,
        empty_miles: 300,
        days_on_load: 4,
        employment: "w2",
        fuel_paid_by: "owner",
        detention_terms_known: true,
      }),
    );
    expect(text).toContain("PAY EVALUATION");
    expect(text).toContain("Verdict: FAIR");
    expect(text).toContain("$1500.00");
    expect(text).toContain("$0.56");
  });
});
