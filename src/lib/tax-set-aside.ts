// Tax set-aside recommendation for 1099 contractors (owner order
// 2026-11-12). Pure math + display conditions, shared by the Home pay
// card, the Paychecks page and the pay-profile card.
//
// The recommendation NEVER moves money - display only. The percent is
// per-company DATA on the pay profile (migration 00094,
// tax_set_aside_bps); NULL on the row means "use the default" and the
// UI labels it as a default. It shows ONLY when worker_type is '1099':
// a W2 profile or a NULL (UNSET) worker_type shows no set-aside line
// at all, and nothing crashes on the NULL.

import { formatRange } from "@/lib/pay-projection";

/** The starting default: 25% of gross per check. Covers the 15.3% self-employment tax plus an income-tax slice. The owner has not picked a % himself; he can change it in Settings -> Pay. */
export const DEFAULT_TAX_SET_ASIDE_BPS = 2500;

/** True only for a 1099 contractor profile. W2 and NULL (UNSET) both hide the set-aside. */
export function isContractor(workerType: string | null | undefined): boolean {
  return workerType === "1099";
}

/** The percent that applies: the stored per-company figure, or the 25% default while it is unset. */
export function taxSetAsideBps(storedBps: number | null | undefined): number {
  return storedBps ?? DEFAULT_TAX_SET_ASIDE_BPS;
}

/** True when no percent is stored, so the figure shown is the default (the UI must say so). */
export function isDefaultTaxSetAside(storedBps: number | null | undefined): boolean {
  return storedBps == null;
}

/** Whole cents to set aside from a gross figure at the given basis points. */
export function taxSetAsideCents(grossCents: number, bps: number): number {
  return Math.round((grossCents * bps) / 10_000);
}

/** Basis points as a plain percent ("25" for 2500 bps). */
export function taxSetAsidePercent(bps: number): number {
  return bps / 100;
}

export interface TaxSetAside {
  /** The basis points actually applied (stored, or the 2500 default). */
  bps: number;
  /** True when the stored percent is unset and the default applies. */
  isDefault: boolean;
  lowCents: number;
  highCents: number;
}

/**
 * The set-aside for a gross range under a profile's worker type and
 * stored percent - or null when the profile is not a 1099 contractor
 * (W2 or worker_type still NULL). A range gross gives a range set-aside;
 * an exact gross gives equal ends.
 */
export function taxSetAsideFor(
  grossLowCents: number,
  grossHighCents: number,
  workerType: string | null | undefined,
  storedBps: number | null | undefined,
): TaxSetAside | null {
  if (!isContractor(workerType)) return null;
  const bps = taxSetAsideBps(storedBps);
  return {
    bps,
    isDefault: isDefaultTaxSetAside(storedBps),
    lowCents: taxSetAsideCents(grossLowCents, bps),
    highCents: taxSetAsideCents(grossHighCents, bps),
  };
}

/** "Set aside for taxes: $152.80 (25% of $611.20 gross)" - the line the Home card and the Paychecks page both show. */
export function describeTaxSetAside(setAside: TaxSetAside, grossLowCents: number, grossHighCents: number): string {
  return `Set aside for taxes: ${formatRange(setAside.lowCents, setAside.highCents)} (${taxSetAsidePercent(setAside.bps)}% of ${formatRange(grossLowCents, grossHighCents)} gross)`;
}

/** "1099 contractor" / "W2 employee" / null while the tax status is UNSET. */
export function workerTypeLabel(workerType: string | null | undefined): string | null {
  if (workerType === "1099") return "1099 contractor";
  if (workerType === "w2") return "W2 employee";
  return null;
}

/** The default label the UI shows next to a default set-aside figure. */
export const TAX_SET_ASIDE_DEFAULT_NOTE = "Default 25% — change it in Settings → Pay";
