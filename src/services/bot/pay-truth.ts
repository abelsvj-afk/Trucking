// Abel Intelligence Upgrade, Phase D (design §5.2-§5.4). True pay
// on ACTUALS: the pay-advisor grades hypothetical offers; this
// module does the same discipline on real settlements - CODE does
// every figure, the model only ever quotes what comes back here.
//
// Three jobs:
// 1. computeTruePay - what a settlement really paid him: tax
//    set-aside (1099), spendable, effective $ on ALL miles (loaded
//    + deadhead) and on ALL duty hours, and the same pay expressed
//    in the other employment model's terms.
// 2. checkSettlementAgainstPin + candidateModels - does this
//    settlement's math reproduce under the pinned structure? A
//    mismatch is RAISED with both figures, never absorbed (design
//    §3.4: this is how a quietly changed pay model gets caught).
//    candidateModels runs the question backwards for the pin
//    proposal: which models COULD have produced this pay line?
// 3. buildWeeklyPayReport - the week's truth, reconciling to the
//    settlement rows to the cent by construction (every figure is
//    a sum or a code computation over those rows).

import { PAY_BANDS } from "@/services/ai/job-knowledge";
import { matching1099Dollars, w2EquivalentDollars } from "./pay-advisor";
import { isPinned, type PayPin } from "./pay-pin";

export interface SettlementFigures {
  issuerName: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  carrierCutCents: number | null;
  netToTruckCents: number | null;
  driverPayCents: number;
  milesTotal: number | null;
  milesLoaded: number | null;
  dutyMinutes: number | null;
}

export interface TruePay {
  taxSetasideCents: number | null;
  spendableCents: number;
  effectiveCpmCents: number | null;
  effectiveHourlyCents: number | null;
  /** His pay expressed in the OTHER employment model's tax terms; null while employment is UNKNOWN (the report then shows both). */
  otherModelPayCents: number | null;
  /** Plain lines explaining each figure - the only text a model may quote. */
  lines: string[];
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function computeTruePay(s: SettlementFigures, pin: PayPin): TruePay {
  const lines: string[] = [];
  const payDollars = s.driverPayCents / 100;

  let taxSetasideCents: number | null = null;
  if (pin.employment === "1099") {
    taxSetasideCents = Math.round(s.driverPayCents * (pin.taxSetasidePercent / 100));
    lines.push(
      `Tax set-aside at ${pin.taxSetasidePercent}% (1099 - put this aside before spending): ${dollars(taxSetasideCents)}.`,
    );
  } else if (pin.employment === "w2") {
    lines.push("W2: tax comes out in withholding on the statement - no separate set-aside.");
  } else {
    lines.push(
      "Employment (W2 vs 1099) isn't pinned yet, so no set-aside is computed - a 1099 week needs roughly a quarter of the pay set aside for tax; a W2 week doesn't.",
    );
  }
  const spendableCents = s.driverPayCents - (taxSetasideCents ?? 0);
  if (taxSetasideCents != null) lines.push(`Spendable: ${dollars(spendableCents)}.`);

  let effectiveCpmCents: number | null = null;
  if (s.milesTotal != null && s.milesTotal > 0) {
    effectiveCpmCents = Math.round(s.driverPayCents / s.milesTotal);
    const loadedNote =
      s.milesLoaded != null ? ` (${s.milesLoaded} loaded + ${s.milesTotal - s.milesLoaded} empty)` : "";
    lines.push(
      `Effective pay on ALL ${s.milesTotal} miles${loadedNote}: $${(effectiveCpmCents / 100).toFixed(2)}/mi - ` +
        `band for this seat is weak under $${PAY_BANDS.effectiveCpmAllMiles.weakBelow.toFixed(2)}, strong over $${PAY_BANDS.effectiveCpmAllMiles.strongAbove.toFixed(2)} (bands are estimates, ${PAY_BANDS.asOf}).`,
    );
  }

  let effectiveHourlyCents: number | null = null;
  if (s.dutyMinutes != null && s.dutyMinutes > 0) {
    effectiveHourlyCents = Math.round(s.driverPayCents / (s.dutyMinutes / 60));
    lines.push(
      `Effective pay on all duty time (${Math.floor(s.dutyMinutes / 60)}h ${String(s.dutyMinutes % 60).padStart(2, "0")}m on duty): $${(effectiveHourlyCents / 100).toFixed(2)}/hr. Unpaid days and deadhead are already inside this number - that's the point of it.`,
    );
  }

  let otherModelPayCents: number | null = null;
  if (pin.employment === "1099") {
    otherModelPayCents = Math.round(w2EquivalentDollars(payDollars, "1099") * 100);
    lines.push(
      `The same work as W2 pay (payroll-tax adjusted only) would read as ${dollars(otherModelPayCents)} gross - the 1099 premium is partly an illusion; protections aren't in this math.`,
    );
  } else if (pin.employment === "w2") {
    otherModelPayCents = Math.round(matching1099Dollars(payDollars, "w2") * 100);
    lines.push(
      `A 1099 offer would need to pay ${dollars(otherModelPayCents)} to match this on taxes alone.`,
    );
  }

  return { taxSetasideCents, spendableCents, effectiveCpmCents, effectiveHourlyCents, otherModelPayCents, lines };
}

// ---------------------------------------------------------------------------
// Pin checking
// ---------------------------------------------------------------------------

export type PinCheckStatus = "fits" | "mismatch" | "unpinned" | "insufficient_data";

export interface PinCheck {
  status: PinCheckStatus;
  expectedCents: number | null;
  actualCents: number;
  detail: string;
}

/** What this settlement's pay line WOULD be under the pin, from the settlement's own gross/miles - null when the settlement doesn't carry the inputs that model needs. */
export function reproducePayUnderPin(
  s: SettlementFigures,
  pin: PayPin,
  linkedLoadCount: number,
): number | null {
  if (pin.rate == null) return null;
  switch (pin.model) {
    case "percentage_gross":
      return Math.round(s.grossCents * (pin.rate / 100));
    case "percentage_net":
      return s.netToTruckCents != null ? Math.round(s.netToTruckCents * (pin.rate / 100)) : null;
    case "cpm_all_miles":
      return s.milesTotal != null ? Math.round(pin.rate * 100 * s.milesTotal) : null;
    case "cpm_loaded":
      return s.milesLoaded != null ? Math.round(pin.rate * 100 * s.milesLoaded) : null;
    case "flat_per_load":
      return linkedLoadCount > 0 ? Math.round(pin.rate * 100) * linkedLoadCount : null;
    case "flat_per_day": {
      const days =
        (Date.parse(s.periodEnd) - Date.parse(s.periodStart)) / (24 * 60 * 60 * 1000) + 1;
      return Number.isFinite(days) && days > 0 ? Math.round(pin.rate * 100) * Math.round(days) : null;
    }
    default:
      return null;
  }
}

/** Fits = reproduces within $1 or 1% (settlements round; models don't get to be wrong quietly beyond that). */
const FIT_TOLERANCE_CENTS = 100;
const FIT_TOLERANCE_RATIO = 0.01;

export function checkSettlementAgainstPin(
  s: SettlementFigures,
  pin: PayPin,
  linkedLoadCount: number,
): PinCheck {
  const actualCents = s.driverPayCents;
  if (!isPinned(pin)) {
    return {
      status: "unpinned",
      expectedCents: null,
      actualCents,
      detail: "No pay pin yet - this settlement can't be checked against a structure. It CAN be used to propose the pin (see which models fit its pay line).",
    };
  }
  if (pin.model === "mixed") {
    return {
      status: "insufficient_data",
      expectedCents: null,
      actualCents,
      detail: "The pin is 'mixed' - no single formula reproduces it, so this settlement is recorded without an automatic check. Eyeball the lines against the pin's terms.",
    };
  }
  const expectedCents = reproducePayUnderPin(s, pin, linkedLoadCount);
  if (expectedCents == null) {
    return {
      status: "insufficient_data",
      expectedCents: null,
      actualCents,
      detail: `The settlement doesn't carry the numbers the pinned model (${pin.model}) needs to reproduce the pay line - recorded unchecked rather than guessed at.`,
    };
  }
  const tolerance = Math.max(FIT_TOLERANCE_CENTS, Math.round(actualCents * FIT_TOLERANCE_RATIO));
  if (Math.abs(expectedCents - actualCents) <= tolerance) {
    return {
      status: "fits",
      expectedCents,
      actualCents,
      detail: `Fits the pin: ${pin.model} reproduces ${dollars(expectedCents)} vs the statement's ${dollars(actualCents)}.`,
    };
  }
  return {
    status: "mismatch",
    expectedCents,
    actualCents,
    detail:
      `MISMATCH: the pin (${pin.model}${pin.rate != null ? ` at ${pin.rate}` : ""}) reproduces ${dollars(expectedCents)}, ` +
      `but the statement paid ${dollars(actualCents)} - a ${dollars(Math.abs(expectedCents - actualCents))} difference. ` +
      "Either the structure changed, a line is missing, or the pin is wrong. This needs his eyes - do not absorb it silently.",
  };
}

export interface CandidateModel {
  model: "percentage_gross" | "percentage_net" | "cpm_all_miles" | "cpm_loaded" | "flat_per_load";
  /** The rate this model would need: percent for percentage models, dollars/mile for CPM, dollars/load for flat. */
  impliedRate: number;
  /** Inside the plausible band for a driver in this seat (bands are estimates). */
  plausible: boolean;
  note: string;
}

/**
 * The pin proposal's working (design §5.1): run the settlement's pay
 * line backwards through every simple model and report which rates
 * would reproduce it - plausible ones first. This never PICKS a
 * model; it shows him the fits and lets him pin.
 */
export function candidateModels(s: SettlementFigures, linkedLoadCount: number): CandidateModel[] {
  const out: CandidateModel[] = [];
  const pctBand = PAY_BANDS.percentageOfGross;
  if (s.grossCents > 0) {
    const pct = (s.driverPayCents / s.grossCents) * 100;
    out.push({
      model: "percentage_gross",
      impliedRate: Math.round(pct * 10) / 10,
      plausible: pct >= pctBand.weakBelow - 7 && pct <= pctBand.strongAbove + 15,
      note: `${dollars(s.driverPayCents)} is ${pct.toFixed(1)}% of the ${dollars(s.grossCents)} gross (fair band for this seat: ${pctBand.fairFrom}-${pctBand.strongAbove}%).`,
    });
  }
  if (s.netToTruckCents != null && s.netToTruckCents > 0) {
    const pct = (s.driverPayCents / s.netToTruckCents) * 100;
    out.push({
      model: "percentage_net",
      impliedRate: Math.round(pct * 10) / 10,
      plausible: pct >= 15 && pct <= 60,
      note: `${dollars(s.driverPayCents)} is ${pct.toFixed(1)}% of the truck's ${dollars(s.netToTruckCents)} net - only meaningful if the deduction list behind that net is known.`,
    });
  }
  if (s.milesTotal != null && s.milesTotal > 0) {
    const cpm = s.driverPayCents / 100 / s.milesTotal;
    out.push({
      model: "cpm_all_miles",
      impliedRate: Math.round(cpm * 100) / 100,
      plausible: cpm >= 0.35 && cpm <= 1.25,
      note: `${dollars(s.driverPayCents)} over ${s.milesTotal} all miles is $${cpm.toFixed(2)}/mi (band for this seat: weak under $${PAY_BANDS.effectiveCpmAllMiles.weakBelow.toFixed(2)}, strong over $${PAY_BANDS.effectiveCpmAllMiles.strongAbove.toFixed(2)}).`,
    });
  }
  if (s.milesLoaded != null && s.milesLoaded > 0) {
    const cpm = s.driverPayCents / 100 / s.milesLoaded;
    out.push({
      model: "cpm_loaded",
      impliedRate: Math.round(cpm * 100) / 100,
      plausible: cpm >= 0.4 && cpm <= 1.5,
      note: `${dollars(s.driverPayCents)} over ${s.milesLoaded} loaded miles is $${cpm.toFixed(2)}/mi loaded-only (the empty miles would be unpaid).`,
    });
  }
  if (linkedLoadCount > 0) {
    const flat = s.driverPayCents / 100 / linkedLoadCount;
    out.push({
      model: "flat_per_load",
      impliedRate: Math.round(flat * 100) / 100,
      plausible: flat >= 150 && flat <= 2500,
      note: `${dollars(s.driverPayCents)} across ${linkedLoadCount} linked load(s) is $${flat.toFixed(2)} per load.`,
    });
  }
  return out.sort((a, b) => Number(b.plausible) - Number(a.plausible));
}

// ---------------------------------------------------------------------------
// Weekly true-pay report (design §5.4)
// ---------------------------------------------------------------------------

export interface WeekLoad {
  origin: string;
  destination: string;
  rateCents: number | null;
  miles: number | null;
}

export interface WeeklyReport {
  text: string;
  figures: {
    settlementCount: number;
    grossCents: number;
    carrierCutCents: number | null;
    driverPayCents: number;
    taxSetasideCents: number | null;
    spendableCents: number;
    milesTotal: number | null;
    effectiveCpmCents: number | null;
    ownAuthorityGrossCents: number;
  };
}

/**
 * Builds the week's report from settlement rows + completed loads.
 * Every figure is a sum over the rows passed in (the caller loads
 * them from the DB) - the report reconciles to the settlement rows
 * to the cent by construction. The own-authority comparison uses
 * the completed loads' recorded grosses and is labeled an estimate:
 * under his own authority the gross would be his, AND so would the
 * fuel, insurance, and factoring.
 */
export function buildWeeklyPayReport(input: {
  weekLabel: string;
  /** Stored settlement rows carry their record-time pin check; the report surfaces mismatches rather than letting a week bury one. */
  settlements: (SettlementFigures & { pinCheck?: string })[];
  completedLoads: WeekLoad[];
  pin: PayPin;
}): WeeklyReport {
  const { settlements, completedLoads, pin } = input;
  const sum = (values: (number | null)[]) =>
    values.every((v) => v == null) ? null : values.reduce<number>((t, v) => t + (v ?? 0), 0);

  const grossCents = settlements.reduce((t, s) => t + s.grossCents, 0);
  const carrierCutCents = sum(settlements.map((s) => s.carrierCutCents));
  const driverPayCents = settlements.reduce((t, s) => t + s.driverPayCents, 0);
  const milesTotal = sum(settlements.map((s) => s.milesTotal));
  const dutyMinutes = sum(settlements.map((s) => s.dutyMinutes));

  let taxSetasideCents: number | null = null;
  if (pin.employment === "1099" && settlements.length > 0) {
    taxSetasideCents = Math.round(driverPayCents * (pin.taxSetasidePercent / 100));
  }
  const spendableCents = driverPayCents - (taxSetasideCents ?? 0);
  const effectiveCpmCents =
    milesTotal != null && milesTotal > 0 ? Math.round(driverPayCents / milesTotal) : null;
  const ownAuthorityGrossCents = completedLoads.reduce((t, l) => t + (l.rateCents ?? 0), 0);

  const lines: string[] = [`Weekly pay truth — ${input.weekLabel}`];
  if (settlements.length === 0) {
    lines.push(
      "No settlement landed this week, so there's no pay truth to report yet - when one comes in (photo it, or tell me), it gets recorded and checked against your pay structure.",
    );
    if (!isPinned(pin)) {
      lines.push(
        "Open question still standing: your pay structure isn't pinned. One settlement is enough for me to show you which model its math fits and propose the pin.",
      );
    }
  } else {
    lines.push(
      `Settlements: ${settlements.length} from ${[...new Set(settlements.map((s) => s.issuerName))].join(", ")}.`,
    );
    lines.push(`The loads grossed: ${dollars(grossCents)}.`);
    if (carrierCutCents != null) {
      lines.push(`The carrier's cut on the statements: ${dollars(carrierCutCents)}.`);
    }
    lines.push(`Your pay: ${dollars(driverPayCents)}.`);
    const mismatches = settlements.filter((s) => s.pinCheck === "mismatch").length;
    if (mismatches > 0) {
      lines.push(
        `⚠ ${mismatches} settlement(s) this week did NOT match the pin - the statement paid a different figure than the pinned structure reproduces. Both figures are on the settlement record; ask me and I'll walk them. A quiet pay-model change is exactly what this check exists to catch.`,
      );
    }
    if (!isPinned(pin)) {
      // Design §5.4 + §2 rule 1: while unpinned, the report shows
      // the candidate models the week's math fits - never one
      // model stated as his.
      const aggregate: SettlementFigures = {
        issuerName: "",
        periodStart: "",
        periodEnd: "",
        grossCents,
        carrierCutCents,
        netToTruckCents: sum(settlements.map((s) => s.netToTruckCents)),
        driverPayCents,
        milesTotal,
        milesLoaded: sum(settlements.map((s) => s.milesLoaded)),
        dutyMinutes,
      };
      const fits = candidateModels(aggregate, 0).filter((c) => c.plausible).slice(0, 3);
      if (fits.length > 0) {
        lines.push(
          `Your structure is still NOT PINNED. This week's pay fits: ${fits
            .map((c) => `${c.model} at ${c.model.startsWith("percentage") ? `${c.impliedRate}%` : `$${c.impliedRate.toFixed(2)}/mi`}`)
            .join("; ")}. Pin one with a yes and every future settlement gets checked against it.`,
        );
      }
    }
    if (taxSetasideCents != null) {
      lines.push(`Set aside for tax (${pin.taxSetasidePercent}%, 1099): ${dollars(taxSetasideCents)}.`);
      lines.push(`Spendable: ${dollars(spendableCents)} - saving targets read from THIS number, not the gross.`);
    }
    if (effectiveCpmCents != null && milesTotal != null) {
      lines.push(`Effective pay: $${(effectiveCpmCents / 100).toFixed(2)} per mile over all ${milesTotal} miles.`);
    }
    if (dutyMinutes != null && dutyMinutes > 0) {
      const hourly = Math.round(driverPayCents / (dutyMinutes / 60));
      lines.push(`Effective pay: $${(hourly / 100).toFixed(2)} per duty hour (unpaid days and deadhead included).`);
    }
    const deadheadMiles = sum(settlements.map((s) =>
      s.milesTotal != null && s.milesLoaded != null ? s.milesTotal - s.milesLoaded : null,
    ));
    if (deadheadMiles != null && milesTotal != null && milesTotal > 0) {
      lines.push(`Deadhead: ${deadheadMiles} of ${milesTotal} miles (${Math.round((deadheadMiles / milesTotal) * 100)}%).`);
    }
  }
  if (completedLoads.length > 0 && ownAuthorityGrossCents > 0) {
    lines.push(
      `Same loads under your own authority (ESTIMATE): the ${completedLoads.length} completed load(s) grossed ${dollars(ownAuthorityGrossCents)} at the broker/carrier level - ` +
        "that gross would be yours, and so would the fuel, insurance, factoring, and the carrier's work. It's the business you're learning, priced on your real week.",
    );
  }
  return {
    text: lines.join("\n"),
    figures: {
      settlementCount: settlements.length,
      grossCents,
      carrierCutCents,
      driverPayCents,
      taxSetasideCents,
      spendableCents,
      milesTotal,
      effectiveCpmCents,
      ownAuthorityGrossCents,
    },
  };
}

// ---------------------------------------------------------------------------
// Lease-on economics explainer (design §5.4, v1)
// ---------------------------------------------------------------------------

/** The typical lease-on carrier cut - GENERAL knowledge, labeled as such everywhere it appears; it is never presented as Steven's or this carrier's number. */
export const TYPICAL_CARRIER_CUT_BAND = { lowPct: 20, highPct: 30 } as const;

export interface LoadEconomics {
  lines: string[];
}

/**
 * Walks one completed load's money: what it grossed, what the
 * carrier's cut likely was (labeled band, unless a settlement line
 * gives the actual), what the truck's share was, what he earned
 * (actual line, or under the pin, or honestly unknown), and the
 * own-authority flip. Numbers only from the inputs.
 */
export function explainLoadEconomics(input: {
  origin: string;
  destination: string;
  grossCents: number;
  miles: number | null;
  /** His actual pay for this load from a settlement line, when one is linked. */
  actualPayCents?: number | null;
  /** The carrier's actual cut for this load, when a settlement shows it. */
  actualCarrierCutCents?: number | null;
  pin: PayPin;
}): LoadEconomics {
  const { grossCents, pin } = input;
  const lines: string[] = [
    `Load economics — ${input.origin} → ${input.destination}, gross ${dollars(grossCents)}${input.miles ? ` over ${input.miles} miles` : ""}:`,
  ];
  let truckShareCents: number | null = null;
  if (input.actualCarrierCutCents != null) {
    truckShareCents = grossCents - input.actualCarrierCutCents;
    lines.push(
      `The carrier kept ${dollars(input.actualCarrierCutCents)} (from the settlement - the actual, not a guess). The truck's share: ${dollars(truckShareCents)}.`,
    );
  } else {
    const low = Math.round(grossCents * (TYPICAL_CARRIER_CUT_BAND.lowPct / 100));
    const high = Math.round(grossCents * (TYPICAL_CARRIER_CUT_BAND.highPct / 100));
    truckShareCents = grossCents - Math.round(grossCents * ((TYPICAL_CARRIER_CUT_BAND.lowPct + TYPICAL_CARRIER_CUT_BAND.highPct) / 2 / 100));
    lines.push(
      `The carrier's cut isn't on a settlement for this load yet. A typical lease-on cut is ${TYPICAL_CARRIER_CUT_BAND.lowPct}-${TYPICAL_CARRIER_CUT_BAND.highPct}% of gross (general band, NOT this carrier's number) - that's ${dollars(low)}-${dollars(high)}, leaving the truck roughly ${dollars(truckShareCents)} at the midpoint.`,
    );
  }
  if (input.actualPayCents != null) {
    lines.push(`Your pay on this load (from the settlement): ${dollars(input.actualPayCents)}.`);
  } else if (isPinned(pin) && pin.rate != null) {
    const fake: SettlementFigures = {
      issuerName: "",
      periodStart: "",
      periodEnd: "",
      grossCents,
      carrierCutCents: null,
      netToTruckCents: truckShareCents,
      driverPayCents: 0,
      milesTotal: input.miles,
      milesLoaded: input.miles,
      dutyMinutes: null,
    };
    const expected = reproducePayUnderPin(fake, pin, 1);
    if (expected != null) {
      lines.push(
        `Under your pin (${pin.model}), your pay on a load like this works out to ${dollars(expected)} - the settlement will prove or correct that when it lands.`,
      );
    }
  } else {
    lines.push(
      "Your pay on this load isn't known yet - the structure isn't pinned and no settlement line covers it. That's the open question the pin closes.",
    );
  }
  lines.push(
    `Under your own authority, the full ${dollars(grossCents)} would be YOUR gross - and the fuel, insurance, factoring, and dispatch work the carrier's cut pays for would be yours too. Same load, both seats: that's the lesson this seat is teaching.`,
  );
  return { lines };
}
