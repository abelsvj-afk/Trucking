// Abel Job Brain (docs/design/driver-mvp.md §11). The pay advisor:
// given a pay structure and a load's numbers, CODE does the math -
// the model never computes a figure. It converts any offer shape
// (CPM loaded-only or all-miles, percentage of gross or net, flat)
// into the numbers that make offers comparable: total pay for the
// load, effective CPM on ALL miles, a weekly projection, the
// percentage-of-gross equivalent, and the W2<->1099 adjustment -
// then grades the result against the job-knowledge bands (the same
// constants the coaching uses) and lists the questions whose
// answers would change the verdict.

import { z } from "zod";
import { PAY_BANDS } from "@/services/ai/job-knowledge";

export const payOfferArgs = z.object({
  structure: z.enum([
    "cpm_all_miles",
    "cpm_loaded_only",
    "percentage_gross",
    "percentage_net",
    "flat_per_load",
    "flat_per_day",
  ]),
  /** For cpm_* structures: the quoted cents-per-mile, in dollars (0.60 = 60 cents). */
  cpm_dollars: z.number().positive().optional(),
  /** For percentage_* structures: the driver's cut, 0-100. */
  percentage: z.number().min(0).max(100).optional(),
  /** What the load pays the truck, in dollars - needed for percentage math and equivalents. */
  load_gross_dollars: z.number().positive().optional(),
  /** For flat_* structures: the flat amount (per load, or per day). */
  flat_dollars: z.number().positive().optional(),
  loaded_miles: z.number().nonnegative(),
  empty_miles: z.number().nonnegative().default(0),
  /** Days the load takes (drives the weekly projection when loads_per_week isn't given). */
  days_on_load: z.number().positive().optional(),
  loads_per_week: z.number().positive().optional(),
  /** Omit when he doesn't know yet - the evaluation then shows both sides and asks. */
  employment: z.enum(["w2", "1099"]).optional(),
  fuel_paid_by: z.enum(["owner", "driver", "unknown"]).optional(),
  detention_terms_known: z.boolean().optional(),
});

// z.input: callers may omit the defaulted fields (empty_miles);
// the function applies the same defaults the schema would.
export type PayOfferInput = z.input<typeof payOfferArgs>;

export type PayVerdict = "strong" | "fair" | "weak" | "incomplete";

export interface PayEvaluation {
  verdict: PayVerdict;
  /** Why the verdict is what it is, in plain lines. */
  reasons: string[];
  totalPayDollars: number | null;
  effectiveCpmAllMiles: number | null;
  weeklyGrossDollars: number | null;
  percentageOfGross: number | null;
  /** What this pay equals as a W2 gross once the payroll-tax difference is applied (his offer, converted). */
  w2EquivalentDollars: number | null;
  /** What a 1099 offer would need to pay to match this pay if it were W2 (tax-only breakeven). */
  matching1099Dollars: number | null;
  questionsThatChangeTheAnswer: string[];
  bandsAsOf: string;
}

// Self-employment tax: 15.3% applied to 92.35% of net earnings.
// Employee-side payroll tax (the W2 half): 7.65%.
const SE_TAX_EFFECTIVE = 0.153 * 0.9235;
const EMPLOYEE_FICA = 0.0765;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

type Grade = "strong" | "fair" | "weak";

function gradeOf(value: number, weakBelow: number, strongAbove: number): Grade {
  if (value < weakBelow) return "weak";
  if (value > strongAbove) return "strong";
  return "fair";
}

function combineGrades(grades: Grade[]): Grade {
  if (grades.includes("weak")) return "weak";
  if (grades.every((g) => g === "strong")) return "strong";
  return "fair";
}

export function evaluatePayOffer(input: PayOfferInput): PayEvaluation {
  const emptyMiles = input.empty_miles ?? 0;
  const totalMiles = input.loaded_miles + emptyMiles;
  const questions: string[] = [];
  const reasons: string[] = [];

  // -- Total pay for the load, by structure -------------------------------
  let totalPay: number | null = null;
  switch (input.structure) {
    case "cpm_all_miles":
      if (input.cpm_dollars != null) totalPay = input.cpm_dollars * totalMiles;
      break;
    case "cpm_loaded_only":
      if (input.cpm_dollars != null) totalPay = input.cpm_dollars * input.loaded_miles;
      break;
    case "percentage_gross":
    case "percentage_net":
      if (input.percentage != null && input.load_gross_dollars != null) {
        totalPay = (input.percentage / 100) * input.load_gross_dollars;
      }
      break;
    case "flat_per_load":
      if (input.flat_dollars != null) totalPay = input.flat_dollars;
      break;
    case "flat_per_day":
      if (input.flat_dollars != null && input.days_on_load != null) {
        totalPay = input.flat_dollars * input.days_on_load;
      }
      break;
  }

  if (totalPay == null) {
    const missing =
      input.structure === "flat_per_day"
        ? "the flat daily amount and how many days the load takes"
        : input.structure.startsWith("percentage")
          ? "the percentage AND what the load pays the truck (gross)"
          : "the per-mile rate";
    return {
      verdict: "incomplete",
      reasons: [`Can't grade this one yet - missing ${missing}.`],
      totalPayDollars: null,
      effectiveCpmAllMiles: null,
      weeklyGrossDollars: null,
      percentageOfGross: null,
      w2EquivalentDollars: null,
      matching1099Dollars: null,
      questionsThatChangeTheAnswer: [`What is ${missing}?`],
      bandsAsOf: PAY_BANDS.asOf,
    };
  }

  // -- Comparable figures ---------------------------------------------------
  const effectiveCpm = totalMiles > 0 ? totalPay / totalMiles : null;

  const loadsPerWeek =
    input.loads_per_week ??
    (input.days_on_load != null ? 7 / input.days_on_load : null);
  const weekly = loadsPerWeek != null ? totalPay * loadsPerWeek : null;

  const percentageOfGross =
    input.load_gross_dollars != null && input.load_gross_dollars > 0
      ? (totalPay / input.load_gross_dollars) * 100
      : null;

  // W2 <-> 1099, tax-only: what the same after-payroll-tax money
  // looks like on the other side. Protections (workers' comp,
  // unemployment) aren't in this math - the questions cover them.
  const totalPayRounded = round2(totalPay);
  const w2Equivalent =
    input.employment === "1099"
      ? round2((totalPay * (1 - SE_TAX_EFFECTIVE)) / (1 - EMPLOYEE_FICA))
      : input.employment === "w2"
        ? totalPayRounded
        : null;
  const matching1099 =
    input.employment === "w2"
      ? round2((totalPay * (1 - EMPLOYEE_FICA)) / (1 - SE_TAX_EFFECTIVE))
      : input.employment === "1099"
        ? totalPayRounded
        : null;

  // -- Verdict against the bands -------------------------------------------
  const grades: Grade[] = [];
  if (effectiveCpm != null) {
    const grade = gradeOf(
      effectiveCpm,
      PAY_BANDS.effectiveCpmAllMiles.weakBelow,
      PAY_BANDS.effectiveCpmAllMiles.strongAbove,
    );
    grades.push(grade);
    reasons.push(
      `Effective CPM on all ${totalMiles} miles (loaded + empty): $${effectiveCpm.toFixed(2)} - ${grade} against the band (weak under $${PAY_BANDS.effectiveCpmAllMiles.weakBelow.toFixed(2)}, strong over $${PAY_BANDS.effectiveCpmAllMiles.strongAbove.toFixed(2)}).`,
    );
  }
  if (weekly != null) {
    const grade = gradeOf(
      weekly,
      PAY_BANDS.weeklyGrossDollars.weakBelow,
      PAY_BANDS.weeklyGrossDollars.strongAbove,
    );
    grades.push(grade);
    reasons.push(
      `Weekly projection at this pace: $${round2(weekly).toFixed(2)} gross - ${grade} against the band (weak under $${PAY_BANDS.weeklyGrossDollars.weakBelow}, strong over $${PAY_BANDS.weeklyGrossDollars.strongAbove}).`,
    );
  }
  if (
    (input.structure === "percentage_gross" || input.structure === "percentage_net") &&
    input.percentage != null
  ) {
    const grade =
      input.percentage < PAY_BANDS.percentageOfGross.weakBelow
        ? "weak"
        : input.percentage > PAY_BANDS.percentageOfGross.strongAbove
          ? "strong"
          : input.percentage >= PAY_BANDS.percentageOfGross.fairFrom
            ? "fair"
            : "weak";
    grades.push(grade);
    reasons.push(
      `The percentage itself (${input.percentage}% of ${input.structure === "percentage_net" ? "NET" : "gross"}) grades ${grade} against the band (weak under ${PAY_BANDS.percentageOfGross.weakBelow}%, fair ${PAY_BANDS.percentageOfGross.fairFrom}-${PAY_BANDS.percentageOfGross.strongAbove}%).`,
    );
    if (input.structure === "percentage_net") {
      reasons.push(
        "Percentage of NET is only as good as the deduction list - an unnamed 'net' can quietly grade far below what the headline percentage suggests.",
      );
    }
  }
  if (input.structure === "cpm_loaded_only" && emptyMiles > 0) {
    reasons.push(
      `Loaded-only CPM leaves ${emptyMiles} empty miles unpaid - the effective all-miles figure above is the honest comparison.`,
    );
  }

  // -- Questions whose answers move the verdict -----------------------------
  if (input.fuel_paid_by == null || input.fuel_paid_by === "unknown") {
    questions.push(
      "Who pays for fuel? In this seat the truck owner normally does - if it lands on you, this offer drops a full grade or worse.",
    );
  } else if (input.fuel_paid_by === "driver") {
    reasons.push(
      "You'd be paying for fuel on someone else's truck - highly unusual in this seat, and it drags the real take well below these figures.",
    );
  }
  if (!input.detention_terms_known) {
    questions.push(
      "What are the detention terms (free hours, then how much per hour) and is there layover/deadhead pay? Strong accessorials can rescue a middling base rate.",
    );
  }
  if (input.structure === "percentage_net") {
    questions.push(
      "Percentage of net - exactly what is deducted before your cut (fuel? insurance? dispatch fee?), and can you see it itemized on every settlement?",
    );
  }
  if (input.structure === "percentage_gross") {
    questions.push(
      "Is your percentage of the linehaul only, or linehaul plus fuel surcharge - and do you get to see the rate con on every load your pay is computed from?",
    );
  }
  if (input.employment == null) {
    questions.push(
      "Is this W2 or 1099? A 1099 offer must pay roughly 20% more than the W2 version (about 8 points of that is payroll tax alone) before it's truly equal - and it carries no workers' comp or unemployment coverage.",
    );
  }
  questions.push(
    "When is pay settled - weekly or per load, and how many days after delivery? Pay timing is a term worth having in writing.",
  );

  return {
    verdict: grades.length > 0 ? combineGrades(grades) : "incomplete",
    reasons,
    totalPayDollars: totalPayRounded,
    effectiveCpmAllMiles: effectiveCpm != null ? round2(effectiveCpm) : null,
    weeklyGrossDollars: weekly != null ? round2(weekly) : null,
    percentageOfGross: percentageOfGross != null ? round2(percentageOfGross) : null,
    w2EquivalentDollars: w2Equivalent,
    matching1099Dollars: matching1099,
    questionsThatChangeTheAnswer: questions,
    bandsAsOf: PAY_BANDS.asOf,
  };
}

/** The tool-result rendering: every figure the model may quote traces to this text. */
export function formatPayEvaluation(evaluation: PayEvaluation): string {
  const money = (value: number | null) => (value == null ? "n/a" : `$${value.toFixed(2)}`);
  const lines: string[] = [
    `PAY EVALUATION (computed in code; bands are estimates as of ${evaluation.bandsAsOf}):`,
    `Verdict: ${evaluation.verdict.toUpperCase()}`,
  ];
  if (evaluation.totalPayDollars != null) {
    lines.push(`Pay for this load: ${money(evaluation.totalPayDollars)}`);
  }
  if (evaluation.effectiveCpmAllMiles != null) {
    lines.push(`Effective CPM on all miles: $${evaluation.effectiveCpmAllMiles.toFixed(2)}`);
  }
  if (evaluation.weeklyGrossDollars != null) {
    lines.push(`Weekly projection: ${money(evaluation.weeklyGrossDollars)} gross`);
  }
  if (evaluation.percentageOfGross != null) {
    lines.push(`Equivalent share of the load's gross: ${evaluation.percentageOfGross.toFixed(1)}%`);
  }
  if (evaluation.w2EquivalentDollars != null) {
    lines.push(
      `As a W2-equivalent (payroll-tax adjusted): ${money(evaluation.w2EquivalentDollars)}`,
    );
  }
  if (evaluation.matching1099Dollars != null) {
    lines.push(
      `A 1099 offer would need to pay ${money(evaluation.matching1099Dollars)} to match this on taxes alone`,
    );
  }
  for (const reason of evaluation.reasons) lines.push(`- ${reason}`);
  if (evaluation.questionsThatChangeTheAnswer.length > 0) {
    lines.push("Questions that would change the answer:");
    for (const question of evaluation.questionsThatChangeTheAnswer) {
      lines.push(`- ${question}`);
    }
  }
  return lines.join("\n");
}
