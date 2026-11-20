// Auditor checks, in code (Phase 0 baseline; plan docs/bot-team-build-plan.md).
// The Auditor bot (docs/bots/auditor/CLAUDE.md) is read-only, flag only:
// it recomputes every number itself and flags what does not add up,
// with both numbers shown. It never fixes things silently.
//
// This module is the recomputation. Pure — no database, no network —
// so the same draft always gets the same verdict, and the tests can
// prove it. Phrasing drift ("the same kind of thing described a
// different way") is a model judgement, not arithmetic, so it is NOT
// here — it stays a human/Auditor-model job.
//
// Tolerances: money is integer cents; a pay mismatch over $1.00 is a
// real disagreement, not rounding. A per-mile figure off by more than
// 1 cent is a real disagreement. Anything the source does not give us
// is flagged "cannot verify" with the missing piece named — never
// presented as a fact.

import { formatMoney } from "@/lib/money-format";

export interface LoadDraftInput {
  /** Broker's rate in cents per loaded mile; null when the broker quoted a flat total. */
  rateCentsPerLoadedMile: number | null;
  /** Total pay quoted for the load, in cents; null when not quoted. */
  payCents: number | null;
  loadedMiles: number | null;
  deadheadMiles: number | null;
  /** What the draft itself claims, when it claims a per-mile figure. */
  claimedPerLoadedMileCents?: number | null;
  claimedPerAllMilesCents?: number | null;
  /** ISO windows; null when the source did not give them. */
  pickupWindowStart?: string | null;
  pickupWindowEnd?: string | null;
  deliveryWindowStart?: string | null;
  deliveryWindowEnd?: string | null;
}

export interface AuditFlag {
  field: string;
  severity: "error" | "unverifiable";
  /** The claim, in the draft's own terms. */
  claim: string;
  /** The source value it was checked against. */
  source: string;
  detail: string;
}

export interface AuditResult {
  passed: boolean;
  flags: AuditFlag[];
  computed: {
    expectedPayCents: number | null;
    perLoadedMileCents: number | null;
    perAllMilesCents: number | null;
    totalMiles: number | null;
  };
}

/** A pay mismatch over $1.00 is a disagreement, not rounding. */
export const PAY_MISMATCH_TOLERANCE_CENTS = 100;
/** A per-mile figure off by more than 1 cent is a disagreement. */
export const PER_MILE_TOLERANCE_CENTS = 1;

function dollars(cents: number): string {
  return formatMoney(cents);
}

function centsPerMile(payCents: number, miles: number): number {
  return Math.round((payCents / miles) * 100) / 100;
}

export function auditLoadDraft(draft: LoadDraftInput): AuditResult {
  const flags: AuditFlag[] = [];
  const totalMiles =
    draft.loadedMiles !== null && draft.deadheadMiles !== null
      ? Math.round((draft.loadedMiles + draft.deadheadMiles) * 100) / 100
      : null;

  const expectedPayCents =
    draft.rateCentsPerLoadedMile !== null && draft.loadedMiles !== null
      ? Math.round(draft.rateCentsPerLoadedMile * draft.loadedMiles)
      : null;

  const perLoadedMileCents =
    draft.payCents !== null && draft.loadedMiles !== null && draft.loadedMiles > 0
      ? centsPerMile(draft.payCents, draft.loadedMiles)
      : null;

  const perAllMilesCents =
    draft.payCents !== null && totalMiles !== null && totalMiles > 0
      ? centsPerMile(draft.payCents, totalMiles)
      : null;

  // Miles x rate must equal the pay quoted.
  if (expectedPayCents !== null && draft.payCents !== null) {
    if (Math.abs(expectedPayCents - draft.payCents) > PAY_MISMATCH_TOLERANCE_CENTS) {
      flags.push({
        field: "pay",
        severity: "error",
        claim: `pay quoted ${dollars(draft.payCents)}`,
        source: `rate ${dollars(draft.rateCentsPerLoadedMile ?? 0)}/loaded mi x ${draft.loadedMiles} loaded mi = ${dollars(expectedPayCents)}`,
        detail: `Pay does not add up: quoted ${dollars(draft.payCents)} vs computed ${dollars(expectedPayCents)} — off by ${dollars(Math.abs(expectedPayCents - draft.payCents))}.`,
      });
    }
  } else if (draft.rateCentsPerLoadedMile === null && draft.payCents !== null) {
    flags.push({
      field: "rate",
      severity: "unverifiable",
      claim: `pay quoted ${dollars(draft.payCents)} with no per-mile rate`,
      source: "broker quoted a flat total, no per-mile rate on file",
      detail: "Cannot verify the pay against a rate — the broker quoted a flat total. Ask for the per-mile rate or verify the total against the rate confirmation.",
    });
  } else if (draft.payCents === null) {
    flags.push({
      field: "pay",
      severity: "unverifiable",
      claim: "no pay quoted",
      source: "no pay figure in the draft or its source",
      detail: "Cannot verify pay — no pay figure was given. A load with no pay is not a proposal.",
    });
  }

  // $ per loaded mile must match the miles given.
  if (draft.claimedPerLoadedMileCents !== undefined && draft.claimedPerLoadedMileCents !== null && perLoadedMileCents !== null) {
    if (Math.abs(draft.claimedPerLoadedMileCents - perLoadedMileCents) > PER_MILE_TOLERANCE_CENTS) {
      flags.push({
        field: "per-loaded-mile",
        severity: "error",
        claim: `${dollars(draft.claimedPerLoadedMileCents)} per loaded mile`,
        source: `pay ${dollars(draft.payCents ?? 0)} / ${draft.loadedMiles} loaded mi = ${dollars(perLoadedMileCents)}`,
        detail: "The claimed $ per loaded mile does not match the pay and miles given.",
      });
    }
  }

  // $ per ALL miles must match the miles given.
  if (draft.claimedPerAllMilesCents !== undefined && draft.claimedPerAllMilesCents !== null && perAllMilesCents !== null) {
    if (Math.abs(draft.claimedPerAllMilesCents - perAllMilesCents) > PER_MILE_TOLERANCE_CENTS) {
      flags.push({
        field: "per-all-miles",
        severity: "error",
        claim: `${dollars(draft.claimedPerAllMilesCents)} per all miles`,
        source: `pay ${dollars(draft.payCents ?? 0)} / ${totalMiles} all mi = ${dollars(perAllMilesCents)}`,
        detail: "The claimed $ per all miles does not match the pay and miles given.",
      });
    }
  }

  if (draft.loadedMiles === null || draft.deadheadMiles === null) {
    flags.push({
      field: "miles",
      severity: "unverifiable",
      claim: `miles given: loaded ${draft.loadedMiles ?? "?"}, deadhead ${draft.deadheadMiles ?? "?"}`,
      source: "miles missing from the draft or its source",
      detail: "Cannot verify $ per mile without both loaded and deadhead miles. A load with missing miles is not priced.",
    });
  }

  // Windows: pickup must end after it starts; delivery must not precede pickup.
  const pickupStart = draft.pickupWindowStart ? Date.parse(draft.pickupWindowStart) : NaN;
  const pickupEnd = draft.pickupWindowEnd ? Date.parse(draft.pickupWindowEnd) : NaN;
  const deliveryStart = draft.deliveryWindowStart ? Date.parse(draft.deliveryWindowStart) : NaN;
  const deliveryEnd = draft.deliveryWindowEnd ? Date.parse(draft.deliveryWindowEnd) : NaN;
  if (!Number.isNaN(pickupStart) && !Number.isNaN(pickupEnd) && pickupEnd <= pickupStart) {
    flags.push({
      field: "pickup-window",
      severity: "error",
      claim: `pickup ${draft.pickupWindowStart} to ${draft.pickupWindowEnd}`,
      source: "pickup window end is not after its start",
      detail: "The pickup window ends before it starts — the window is wrong somewhere.",
    });
  }
  if (!Number.isNaN(pickupStart) && !Number.isNaN(deliveryStart) && deliveryStart < pickupStart) {
    flags.push({
      field: "delivery-window",
      severity: "error",
      claim: `delivery ${draft.deliveryWindowStart} before pickup ${draft.pickupWindowStart}`,
      source: "delivery starts before pickup starts",
      detail: "The delivery is scheduled before the pickup — the dates are wrong somewhere.",
    });
  }
  if (!Number.isNaN(deliveryStart) && !Number.isNaN(deliveryEnd) && deliveryEnd <= deliveryStart) {
    flags.push({
      field: "delivery-window",
      severity: "error",
      claim: `delivery ${draft.deliveryWindowStart} to ${draft.deliveryWindowEnd}`,
      source: "delivery window end is not after its start",
      detail: "The delivery window ends before it starts — the window is wrong somewhere.",
    });
  }
  if (Number.isNaN(pickupStart) || Number.isNaN(pickupEnd) || Number.isNaN(deliveryStart) || Number.isNaN(deliveryEnd)) {
    flags.push({
      field: "windows",
      severity: "unverifiable",
      claim: "one or more windows missing",
      source: "pickup/delivery windows incomplete in the draft or its source",
      detail: "Cannot verify the windows — one or more are missing. Do not judge lateness without the real window.",
    });
  }

  const passed = flags.every((flag) => flag.severity !== "error");
  return { passed, flags, computed: { expectedPayCents, perLoadedMileCents, perAllMilesCents, totalMiles } };
}

export interface InvoiceDraftInput {
  /** Amount on the invoice draft, in cents; null when not stated. */
  invoicedCents: number | null;
  /** Pay agreed for the load, in cents; null when unknown. */
  agreedPayCents: number | null;
  /** Total on the rate confirmation, in cents; null when no rate con on file. */
  rateConTotalCents: number | null;
}

/**
 * An invoice must equal the agreed pay and the rate-confirmation
 * total. A missing rate con is "cannot verify", never a pass by
 * default — an invoice with no source behind it is not checked.
 */
export function auditInvoiceDraft(draft: InvoiceDraftInput): AuditResult {
  const flags: AuditFlag[] = [];
  if (draft.invoicedCents === null) {
    flags.push({
      field: "invoice",
      severity: "unverifiable",
      claim: "no invoice amount given",
      source: "no invoice amount in the draft or its source",
      detail: "Cannot verify the invoice — no amount was given.",
    });
    return { passed: true, flags, computed: { expectedPayCents: null, perLoadedMileCents: null, perAllMilesCents: null, totalMiles: null } };
  }
  if (draft.agreedPayCents !== null && Math.abs(draft.invoicedCents - draft.agreedPayCents) > PAY_MISMATCH_TOLERANCE_CENTS) {
    flags.push({
      field: "invoice",
      severity: "error",
      claim: `invoiced ${dollars(draft.invoicedCents)}`,
      source: `agreed pay ${dollars(draft.agreedPayCents)}`,
      detail: `The invoice does not match the agreed pay: invoiced ${dollars(draft.invoicedCents)} vs agreed ${dollars(draft.agreedPayCents)} — off by ${dollars(Math.abs(draft.invoicedCents - draft.agreedPayCents))}.`,
    });
  }
  if (draft.rateConTotalCents !== null && Math.abs(draft.invoicedCents - draft.rateConTotalCents) > PAY_MISMATCH_TOLERANCE_CENTS) {
    flags.push({
      field: "invoice",
      severity: "error",
      claim: `invoiced ${dollars(draft.invoicedCents)}`,
      source: `rate confirmation total ${dollars(draft.rateConTotalCents)}`,
      detail: `The invoice does not match the rate confirmation: invoiced ${dollars(draft.invoicedCents)} vs rate con ${dollars(draft.rateConTotalCents)} — off by ${dollars(Math.abs(draft.invoicedCents - draft.rateConTotalCents))}.`,
    });
  }
  if (draft.agreedPayCents === null && draft.rateConTotalCents === null) {
    flags.push({
      field: "invoice",
      severity: "unverifiable",
      claim: `invoiced ${dollars(draft.invoicedCents)} with no agreed pay and no rate con`,
      source: "no agreed pay and no rate confirmation on file",
      detail: "Cannot verify the invoice against anything — there is no agreed pay and no rate confirmation. Do not treat the invoiced amount as agreed.",
    });
  }
  const passed = flags.every((flag) => flag.severity !== "error");
  return { passed, flags, computed: { expectedPayCents: draft.agreedPayCents, perLoadedMileCents: null, perAllMilesCents: null, totalMiles: null } };
}

export interface SourceFieldComparison {
  /** e.g. "pickup-address", "delivery-window", "broker-rate". */
  field: string;
  /** What the draft says; null when the draft does not state it. */
  draft: string | null;
  /** What the source says; null when the source is missing. */
  source: string | null;
}

/**
 * Draft vs source, field by field: a time that moved, an address
 * that changed, a window or rate that does not match the dispatch
 * or the rate confirmation. A value that differs is an error flag
 * with both values shown; a missing source is "cannot verify" with
 * the missing piece named. Comparison is exact after trimming —
 * a difference in wording is a difference, and the owner decides
 * which wording is right (phrasing drift stays a model judgement
 * on top of this).
 */
export function auditDraftVsSource(fields: SourceFieldComparison[]): AuditFlag[] {
  const flags: AuditFlag[] = [];
  for (const { field, draft, source } of fields) {
    if (draft === null) {
      flags.push({
        field,
        severity: "unverifiable",
        claim: "draft does not state this",
        source: source ?? "no source on file",
        detail: `Cannot verify ${field} — the draft does not state it.`,
      });
      continue;
    }
    if (source === null) {
      flags.push({
        field,
        severity: "unverifiable",
        claim: `${field}: ${draft}`,
        source: "no source on file for this field",
        detail: `Cannot verify ${field} — the source is missing. The draft says "${draft}" and nothing backs it yet.`,
      });
      continue;
    }
    if (draft.trim() !== source.trim()) {
      flags.push({
        field,
        severity: "error",
        claim: `${field}: ${draft}`,
        source: `${field}: ${source}`,
        detail: `The draft does not match its source: draft says "${draft}", source says "${source}".`,
      });
    }
  }
  return flags;
}

/** One-line owner-facing summary of a check: "checks out" or the flags. */
export function auditSummary(result: AuditResult): string {
  if (result.flags.length === 0) return "checks out";
  return result.flags.map((flag) => `${flag.field}: ${flag.detail}`).join("\n");
}

/**
 * The group-chat verdict. Errors are flags, each with both numbers.
 * When nothing is wrong but something could not be verified, the
 * math that was checked still says so — and the unverified part is
 * named, never passed over in silence.
 */
export function formatAuditReply(result: AuditResult): string {
  const errors = result.flags.filter((flag) => flag.severity === "error");
  const unverifiable = result.flags.filter((flag) => flag.severity === "unverifiable");
  if (errors.length > 0) {
    return errors.map((flag) => `${flag.field}: ${flag.detail}`).join(" ");
  }
  if (unverifiable.length > 0) {
    return (
      `Checks out on the numbers given. Cannot verify: ` +
      unverifiable.map((flag) => `${flag.field} — ${flag.detail}`).join(" ")
    );
  }
  return "checks out";
}
