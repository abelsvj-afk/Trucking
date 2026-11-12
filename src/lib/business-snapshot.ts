import { formatMoney } from "@/lib/money-format";

// Own-business snapshot (docs/design/autonomous-research.md §3):
// the pure builder that turns a company's own records into the
// knowledge lines Abel reasons from. Everything here is computed
// from figures the loader read out of his records - no estimates, no
// constants. Pay terms arrive as DATA from employer_pay_profiles
// (rate + basis), employer-agnostic: no employer name, and when the
// basis is unset the snapshot says UNSET instead of picking one -
// the same honesty rule the pay projection follows.

export interface BusinessSnapshotInput {
  /** Loads with pickup_date inside the window (all statuses - a booked load is activity even before it completes). */
  loadsInWindow: number;
  /** Loads in the window already completed. */
  loadsCompleted: number;
  /** Total miles on those loads (the miles figure on the load records). */
  totalMiles: number;
  /** Sum of load rates in cents, or null when no load in the window carries a rate. */
  revenueCents: number | null;
  /** Sum of expenses in the window, cents. */
  expenseCents: number;
  /** Top lanes by load count: "Origin → Destination ×n". */
  topLanes: string[];
  /** Current pay-profile terms, read as data. Null = no profile on file. */
  payProfile: {
    rateCentsPerMile: number;
    mileBasis: string | null;
  } | null;
  windowDays: number;
}

export interface BusinessSnapshot {
  title: string;
  content: string;
}

function dollars(cents: number): string {
  return formatMoney(cents);
}

const BASIS_WORDS: Record<string, string> = {
  all: "all miles (loaded + deadhead)",
  loaded: "loaded miles only",
  practical: "practical miles",
};

/** Builds the snapshot's knowledge title + content. Returns null when there is nothing at all to say. */
export function buildBusinessSnapshot(input: BusinessSnapshotInput): BusinessSnapshot | null {
  const hasActivity = input.loadsInWindow > 0 || input.expenseCents > 0;
  if (!hasActivity && !input.payProfile) return null;

  const lines: string[] = [];
  if (input.loadsInWindow > 0) {
    lines.push(
      `Last ${input.windowDays} days: ${input.loadsInWindow} load${input.loadsInWindow === 1 ? "" : "s"} on the books (${input.loadsCompleted} completed), ${Math.round(input.totalMiles).toLocaleString("en-US")} miles on those loads.`,
    );
    lines.push(
      input.revenueCents !== null
        ? `Load revenue on those loads: ${dollars(input.revenueCents)}.`
        : "Load revenue: not stated - none of those loads carries a rate in his records, so no revenue figure is claimed.",
    );
  } else {
    lines.push(`Last ${input.windowDays} days: no loads on the books in his records.`);
  }
  lines.push(`Expenses recorded in the window: ${dollars(input.expenseCents)}.`);

  if (input.topLanes.length > 0) {
    lines.push(`Most-run lanes: ${input.topLanes.slice(0, 3).join("; ")}.`);
  }

  if (input.payProfile) {
    const rate = `${formatMoney(input.payProfile.rateCentsPerMile)} per mile`;
    const basis = input.payProfile.mileBasis
      ? (BASIS_WORDS[input.payProfile.mileBasis] ?? input.payProfile.mileBasis)
      : "mile basis UNSET in his pay profile - expected-pay figures must be shown as a range until he sets it";
    lines.push(`Current pay terms on file (his data, changeable in Settings): ${rate}, ${basis}.`);
  } else {
    lines.push("Pay terms: no pay profile on file yet, so no per-mile figure is claimed.");
  }

  return {
    title: `His business - last ${input.windowDays} days`,
    content: lines.join(" "),
  };
}
