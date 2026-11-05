// Abel Intelligence Upgrade, Phase D (design §5.1). The pay pin:
// the one first-class, dated, sourced fact that answers "what IS
// his pay structure?" - the question the pay-advisor always had to
// take as an input and nothing in the system owned.
//
// Storage is a business_fact memory (people.ts BUSINESS format) with
// the subject "Pay structure", so the pin rides the Lane 2 memory
// lifecycle for free: a new pin supersedes the old one (same-subject
// business facts close automatically), provenance rides the row,
// hybrid retrieval can find it, and "What Abel remembers" shows it.
// The structured fields ride as key=value pairs inside the fact
// text, parseable exactly like the PERSON/BUSINESS lines.
//
// The pin's most important state is UNKNOWN. Until a real pin lands,
// every pay answer must present the candidate models side by side
// (design §2 rule 1) - UNKNOWN_PIN is that state, and it is the
// default everywhere: a missing or unparseable pin row is UNKNOWN,
// never a guess.

import { parseBusinessFact } from "./people";

export const PAY_PIN_SUBJECT = "Pay structure";

/** The starting set-aside for a 1099 pin until his real numbers exist (design §9, decision 2 - his to change). SE tax alone is ~14.1% effective; the rest is a rough income-tax slice. It is a REPORTING default, never a money movement. */
export const DEFAULT_TAX_SETASIDE_PERCENT = 25;

export type PayModel =
  | "percentage_gross"
  | "percentage_net"
  | "cpm_loaded"
  | "cpm_all_miles"
  | "flat_per_load"
  | "flat_per_day"
  | "mixed"
  | "UNKNOWN";

export type PayEmployment = "w2" | "1099" | "UNKNOWN";
export type PaidBy = "owner" | "driver" | "unknown";

export interface PayPin {
  model: PayModel;
  /** Percentage (0-100) for percentage models; dollars-per-mile for CPM models; dollars for flat models. */
  rate: number | null;
  employment: PayEmployment;
  fuelPaidBy: PaidBy;
  tollsPaidBy: PaidBy;
  /** Weekday name the carrier settles on ("Friday"), when known. */
  settlementDay: string | null;
  /** 1099 only: percent of his pay the weekly report tells him to set aside. */
  taxSetasidePercent: number;
  /** Where the pin came from ("settlement 2026-10-24", "Steven's message 2026-11-03"). */
  source: string | null;
  /** ISO date the pin was pinned. */
  pinnedAt: string | null;
}

export const UNKNOWN_PIN: PayPin = {
  model: "UNKNOWN",
  rate: null,
  employment: "UNKNOWN",
  fuelPaidBy: "unknown",
  tollsPaidBy: "unknown",
  settlementDay: null,
  taxSetasidePercent: DEFAULT_TAX_SETASIDE_PERCENT,
  source: null,
  pinnedAt: null,
};

export function isPinned(pin: PayPin): boolean {
  return pin.model !== "UNKNOWN";
}

const MODELS: PayModel[] = [
  "percentage_gross",
  "percentage_net",
  "cpm_loaded",
  "cpm_all_miles",
  "flat_per_load",
  "flat_per_day",
  "mixed",
  "UNKNOWN",
];

/** Renders the pin as the business_fact line that gets stored. */
export function formatPayPin(pin: PayPin): string {
  const parts = [
    `PIN model=${pin.model}`,
    `rate=${pin.rate ?? "?"}`,
    `employment=${pin.employment}`,
    `fuel=${pin.fuelPaidBy}`,
    `tolls=${pin.tollsPaidBy}`,
    `settle_day=${pin.settlementDay ?? "?"}`,
    `setaside=${pin.taxSetasidePercent}`,
    `pinned=${pin.pinnedAt ?? "?"}`,
    // Source is free text (it can contain spaces) - it rides LAST
    // and the parser takes it as the rest of the line.
    `source=${pin.source ?? "?"}`,
  ];
  return `BUSINESS — ${PAY_PIN_SUBJECT} | ${parts.join(" ")}`;
}

/** Parses a stored business_fact line back into a pin; null when the line isn't a pin at all. A pin-shaped line with a broken field degrades that field to its UNKNOWN default - never to a guess. */
export function parsePayPin(content: string): PayPin | null {
  const parsed = parseBusinessFact(content);
  if (!parsed || parsed.subject !== PAY_PIN_SUBJECT) return null;
  if (!parsed.fact.includes("PIN ")) return null;

  // Source is free text and rides last: lift it out before the
  // key=value token scan so its spaces can't corrupt other fields.
  let factText = parsed.fact;
  let source: string | null = null;
  const sourceMatch = factText.match(/\bsource=(.*)$/);
  if (sourceMatch) {
    source = sourceMatch[1]!.trim() || null;
    if (source === "?") source = null;
    factText = factText.slice(0, sourceMatch.index).trim();
  }

  const fields = new Map<string, string>();
  for (const token of factText.split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const modelRaw = fields.get("model");
  const model: PayModel = MODELS.includes(modelRaw as PayModel)
    ? (modelRaw as PayModel)
    : "UNKNOWN";
  const rateRaw = Number(fields.get("rate"));
  const setasideRaw = Number(fields.get("setaside"));
  const employmentRaw = fields.get("employment");
  const paidBy = (raw: string | undefined): PaidBy =>
    raw === "owner" || raw === "driver" ? raw : "unknown";
  const text = (raw: string | undefined): string | null =>
    raw && raw !== "?" ? raw : null;

  return {
    model,
    rate: Number.isFinite(rateRaw) && fields.get("rate") !== "?" ? rateRaw : null,
    employment:
      employmentRaw === "w2" || employmentRaw === "1099" ? employmentRaw : "UNKNOWN",
    fuelPaidBy: paidBy(fields.get("fuel")),
    tollsPaidBy: paidBy(fields.get("tolls")),
    settlementDay: text(fields.get("settle_day")),
    taxSetasidePercent:
      Number.isFinite(setasideRaw) && fields.get("setaside") != null
        ? setasideRaw
        : DEFAULT_TAX_SETASIDE_PERCENT,
    source,
    pinnedAt: text(fields.get("pinned")),
  };
}

/** Finds the pin among current business_fact rows (newest first in, first pin wins). */
export function findPayPin(rows: { content: string }[]): PayPin {
  for (const row of rows) {
    const pin = parsePayPin(row.content);
    if (pin) return pin;
  }
  return UNKNOWN_PIN;
}

/** One plain line for the context block - what Abel sees every turn. */
export function formatPayPinLine(pin: PayPin): string {
  if (!isPinned(pin)) {
    return (
      "PAY STRUCTURE: NOT PINNED. His pay structure is still unknown - never state a single pay figure as his. " +
      "For any pay question, present the candidate models side by side (percentage of gross, CPM, flat) and say the structure itself is the open question. " +
      "If a settlement or a message from Steven shows how he was actually paid, propose the pin with set_pay_pin (propose) showing which model the math fits."
    );
  }
  const rateText =
    pin.rate == null
      ? "rate unrecorded"
      : pin.model.startsWith("percentage")
        ? `${pin.rate}%`
        : pin.model.startsWith("cpm")
          ? `$${pin.rate.toFixed(2)}/mi`
          : `$${pin.rate}`;
  return (
    `PAY PIN (pinned ${pin.pinnedAt ?? "date unrecorded"}${pin.source ? `, source: ${pin.source}` : ""}): ` +
    `model ${pin.model} at ${rateText}; employment ${pin.employment === "UNKNOWN" ? "not yet confirmed (W2 vs 1099)" : pin.employment}; ` +
    `fuel paid by ${pin.fuelPaidBy}, tolls paid by ${pin.tollsPaidBy}` +
    `${pin.settlementDay ? `; settles ${pin.settlementDay}` : ""}` +
    `${pin.employment === "1099" ? `; tax set-aside ${pin.taxSetasidePercent}% in the weekly report` : ""}.`
  );
}


/** The columns of an employer_pay_profiles row the pin cares about. */
export interface PayProfileRow {
  employer_name: string;
  rate_cents_per_mile: number;
  mile_basis: "loaded" | "all" | "practical" | null;
  worker_type: "w2" | "1099" | null;
  fuel_paid_by: "employer" | "driver" | null;
  effective_from: string;
}

/**
 * A pin derived from the owner's pay-terms profile (migration 00063) - used
 * only when no "Pay structure" memory pin exists. It is a pin ONLY when the
 * miles basis is set to one the pay math can use (loaded / all): an unset (or
 * "practical", which is carrier-computed) basis stays UNKNOWN, because a rate
 * per mile means nothing without knowing which miles. Unset worker type and
 * fuel stay UNKNOWN too - nothing is inferred.
 */
export function payPinFromProfile(row: PayProfileRow | null | undefined): PayPin {
  if (!row || (row.mile_basis !== "loaded" && row.mile_basis !== "all")) return UNKNOWN_PIN;
  return {
    ...UNKNOWN_PIN,
    model: row.mile_basis === "loaded" ? "cpm_loaded" : "cpm_all_miles",
    rate: row.rate_cents_per_mile / 100,
    employment: row.worker_type ?? "UNKNOWN",
    fuelPaidBy: row.fuel_paid_by === "employer" ? "owner" : row.fuel_paid_by === "driver" ? "driver" : "unknown",
    source: `pay terms: ${row.employer_name}, since ${row.effective_from}`,
    pinnedAt: row.effective_from,
  };
}
