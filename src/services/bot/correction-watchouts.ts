// Learning from his corrections (owner 2026-11-17: "continue making Abel smarter"; design
// docs/design/abel-do-what-i-ask.md section 7). Every correction he makes to a waiting proposal is logged
// (bot_proposal_outcomes, outcome "corrected", summary "corrected fields: ..."). A field he has had to fix
// twice or more in the learning window becomes a WATCH-OUT shown to Abel every turn, so a misread he has
// already caught twice is double-checked - or asked about - instead of staged a third time. Pure.

import type { OutcomeRow } from "./learning";

export const CORRECTED_PREFIX = "corrected fields: ";
export const WATCHOUT_THRESHOLD = 2;

/** The summary logged for one correction (field names as the tool spells them). */
export function correctionSummary(fields: string[]): string {
  return `${CORRECTED_PREFIX}${[...new Set(fields)].sort().join(", ")}`;
}

const words = (field: string) => field.replace(/_(cents|dollars|id)$/, "").replace(/_/g, " ");

/** Fields he has corrected at least WATCHOUT_THRESHOLD times, most-corrected first. */
export function correctedFields(rows: OutcomeRow[]): { field: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.outcome !== "corrected" || !r.summary.startsWith(CORRECTED_PREFIX)) continue;
    for (const f of r.summary.slice(CORRECTED_PREFIX.length).split(",").map((s) => s.trim()).filter(Boolean)) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= WATCHOUT_THRESHOLD)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([field, count]) => ({ field, count }));
}

/** The context block, or null when nothing has been corrected often enough. */
export function correctionWatchoutsBlock(rows: OutcomeRow[]): string | null {
  const fields = correctedFields(rows);
  if (fields.length === 0) return null;
  return (
    "WATCH-OUTS FROM HIS OWN CORRECTIONS (he has had to fix these more than once lately - learned in code):\n" +
    fields.map((f) => `- ${words(f.field)}: corrected ${f.count} times`).join("\n") +
    "\nBefore you stage one of these, check it against the source twice (the photo, the forwarded text). If you are not sure of it, " +
    "stage the rest and ASK him for that one value instead of guessing - and say plainly which value you're unsure of."
  );
}
