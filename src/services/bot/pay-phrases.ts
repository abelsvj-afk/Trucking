// Pay-period date phrases for Abel's time tools (owner 2026-11-07; design section 8.1): "payday", "next payday",
// "statement day", "end of the pay week", "last pay week". Resolved from HIS saved pay terms - never hardcoded to any
// employer; an unset field is said so, never guessed. Shares the pay-week logic of lib/pay-projection.

import { paydayAfter, weekBounds } from "@/lib/pay-projection";
import { addDays, daysBetween, formatLong, relativeTo, type Resolved } from "@/lib/temporal";

export interface PayCalendarTerms {
  pay_week_ends_on?: number | null;
  statement_weekday?: number | null;
  payday_weekday?: number | null;
}

const PAY_WORDS = /\b(payday|pay day|paycheck day|statement day|statement|pay week|payweek)\b/;

/** Null when this is not a pay phrase at all (the caller then uses the ordinary date resolver). */
export function resolvePayPhrase(input: string, today: string, terms: PayCalendarTerms | null): Resolved | null {
  const text = String(input ?? "").trim().toLowerCase().replace(/[.,!?]+$/g, "").replace(/\s+/g, " ");
  if (!PAY_WORDS.test(text)) return null;

  const which = /\b(next|upcoming|coming)\b/.test(text) ? "next" : /\b(last|previous|past)\b/.test(text) ? "last" : "this";
  const isPayday = /\b(payday|pay day|paycheck day)\b/.test(text);
  const isStatement = /\bstatement\b/.test(text);
  const wantsStart = /\b(start|beginning) of\b/.test(text);
  const fail = (error: string): Resolved => ({ ok: false, error });
  const ok = (date: string, note: string | null): Resolved => ({ ok: true, date, label: formatLong(date), relative: relativeTo(today, date), note, alternative: null });

  if (!terms) return fail("he has no pay terms saved, so I can't place his pay week, statement or payday - he sets them in Settings → Pay terms");
  const weekEndSet = terms.pay_week_ends_on != null;
  const note = weekEndSet ? null : "His pay week end isn't set, so Monday-Sunday weeks were used.";

  if (isPayday || isStatement) {
    const weekday = isPayday ? terms.payday_weekday : terms.statement_weekday;
    const label = isPayday ? "payday" : "statement day";
    if (weekday == null) return fail(`his ${label} isn't set - he sets it in Settings → Pay terms`);
    // candidate dates: the ones for the last few pay weeks and the next one
    const current = weekBounds(today, terms.pay_week_ends_on);
    const candidates: string[] = [];
    for (let back = -1; back <= 3; back += 1) {
      const end = addDays(current.end, -7 * back);
      const d = paydayAfter(end, weekday);
      if (d) candidates.push(d);
    }
    candidates.sort();
    if (which === "last") {
      const past = candidates.filter((d) => daysBetween(today, d) < 0).pop();
      return past ? ok(past, note) : fail(`couldn't find his last ${label}`);
    }
    const upcoming = candidates.filter((d) => daysBetween(today, d) >= (which === "next" ? 1 : 0))[0];
    if (!upcoming) return fail(`couldn't find his next ${label}`);
    return ok(upcoming, note);
  }

  // "pay week": its start or end
  const shift = which === "next" ? 7 : which === "last" ? -7 : 0;
  const w = weekBounds(addDays(today, shift), terms.pay_week_ends_on);
  return ok(wantsStart ? w.start : w.end, note);
}

/** His CURRENT pay-calendar terms (week end, statement day, payday) from the dated pay profiles, or null. */
export async function loadPayCalendarTerms(
  client: { from: (t: string) => unknown },
  companyId: string,
  today: string,
): Promise<PayCalendarTerms | null> {
  const { termsForDate } = await import("@/lib/paycheck");
  try {
    const query = (client.from("employer_pay_profiles") as {
      select: (c: string) => { eq: (a: string, b: string) => { is: (a: string, b: null) => PromiseLike<{ data: unknown; error: unknown }> } };
    })
      .select("employer_name, rate_cents_per_mile, mile_basis, percent_of_load_bps, pay_week_ends_on, statement_weekday, payday_weekday, effective_from, effective_to")
      .eq("company_id", companyId)
      .is("deleted_at", null);
    const { data, error } = await query;
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const picked = termsForDate(data as never, today);
    return picked ? (picked.terms as PayCalendarTerms) : null;
  } catch {
    return null;
  }
}
