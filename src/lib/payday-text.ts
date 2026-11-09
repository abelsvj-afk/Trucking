// The plain-words line for one payday - the ONE place the wording is decided, so Abel's pay answers and the Paychecks page
// (which renders the same fields) cannot disagree. Pure; reads a PaydayGroup from the pay-summary builder and nothing else.

import { formatCents, formatDay, formatRange } from "@/lib/pay-projection";
import type { PaydayGroup } from "@/services/api/pay-summary";

/** "Fri Nov 13" or "payday not set" */
export const paydayTitle = (g: PaydayGroup): string => (g.payday ? `Payday ${formatDay(g.payday)}` : "Payday not set");

/** What is still owed in words: a range while the miles basis is unset, "nothing more" once statements cover it. */
export function stillOwedWords(g: PaydayGroup): string {
  if (g.stillOwedHighCents <= 0) return g.loadCount === 0 ? "nothing (only money taken out so far)" : "nothing more - statements cover it";
  const low = Math.max(0, g.stillOwedLowCents);
  return formatRange(low, g.stillOwedHighCents);
}

export function formatPayday(g: PaydayGroup): string {
  const lines = [
    `${paydayTitle(g)}${g.overdue ? " - PAST DUE, still owed" : ""} (pay weeks ${formatDay(g.periodStart)} to ${formatDay(g.periodEnd)}, ${g.loadCount} load${g.loadCount === 1 ? "" : "s"}${g.statement ? `; statement ${formatDay(g.statement)}` : ""})`,
    `  Expected total: ${formatRange(g.expectedLowCents, g.expectedHighCents)}${g.unpricedCount > 0 ? ` (+${g.unpricedCount} load${g.unpricedCount === 1 ? "" : "s"} not priced yet)` : ""}`,
    `  Advances taken: ${g.advancesCents > 0 ? `-${formatCents(g.advancesCents)}` : "none"}`,
    `  Pay deductions: ${g.deductionsCents > 0 ? `-${formatCents(g.deductionsCents)}` : "none"}`,
    ...g.deductionLines.map((d) => `    - ${formatCents(d.amountCents)} on ${formatDay(d.date)}: ${d.reason}`),
    `  Net expected: ${formatRange(g.netLowCents, g.netHighCents)}${g.netHighCents < 0 ? " (more taken out than this payday is expected to pay)" : ""}`,
    `  Received so far (statements): ${formatCents(g.receivedCents)}`,
    `  Still owed: ${stillOwedWords(g)}${g.shortCount > 0 ? ` | SHORT ${formatCents(g.shortfallCents)} on ${g.shortCount} load${g.shortCount === 1 ? "" : "s"}` : ""}`,
  ];
  return lines.join("\n");
}
