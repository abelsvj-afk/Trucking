// "What am I going to get paid?" - Abel's code-computed answer (owner 2026-11-06, design
// employer-pay-profile.md section 8). Never the model's arithmetic: the numbers come from the same pure
// projection the app's pages use (lib/pay-projection.ts), priced with the terms in force on each load's date
// (cents per mile and/or percent of the load, or the figure he set on the load himself).

import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import {
  describeTerms,
  formatDay,
  formatRange,
  projectLoad,
  projectPeriod,
  projectPreviousPeriod,
  type LoadProjection,
  type PeriodProjection,
} from "@/lib/pay-projection";
import { termsForDate, type PayTermsRow } from "@/lib/paycheck";
import type { Load } from "@/types/entities";

const PROFILE_COLUMNS =
  "employer_name, rate_cents_per_mile, mile_basis, percent_of_load_bps, pay_week_ends_on, statement_weekday, payday_weekday, effective_from, effective_to";

function projectionLine(load: Load, p: LoadProjection): string {
  const money = p.lowCents === null || p.highCents === null ? "can't be worked out yet" : formatRange(p.lowCents, p.highCents);
  return `- ${load.origin} → ${load.destination} (${load.delivery_date ?? load.pickup_date ?? "no date"}): ${money}${p.overridden ? " [his own figure]" : ""}. ${p.counted ? `Counted: ${p.counted}. ` : ""}${p.note}`;
}

function periodLines(title: string, period: PeriodProjection): string[] {
  const lines = [
    `${title}: ${formatRange(period.lowCents, period.highCents)} (${formatDay(period.start)} to ${formatDay(period.end)}${period.statement ? `, statement ${formatDay(period.statement)}` : ""}${period.payday ? `, paid ${formatDay(period.payday)}` : ", payday not set"})`,
    ...period.rows.map(({ load, projection }) => projectionLine(load as Load, projection)),
  ];
  if (period.rows.length === 0) lines.push("- no booked loads in this period");
  if (period.unavailableCount > 0) lines.push(`(${period.unavailableCount} load(s) above are NOT in the total - each says what is missing.)`);
  if (period.excludedCount > 0) lines.push(`(${period.excludedCount} draft/cancelled load(s) left out.)`);
  return lines;
}

export function buildPayProjectionTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;
  return [
    {
      name: "projected_pay",
      description:
        "What he is going to get paid, computed in code from his pay terms (cents per mile and/or a percent of the load, the dated terms in force on each load's date) or the figure he set on a load himself. With load_id: that one load's pay. Without: THIS pay week so far (the running total toward payday) and LAST pay week, with the payday date when it is set. ALWAYS call this for 'what will I make / what do I get paid / how much by Friday' - never do the pay arithmetic yourself, and say plainly when a figure is a range or can't be worked out. Gross, before fuel, taxes and deductions; the settlement is the final number.",
      parameters: {
        type: "object",
        properties: { load_id: { type: "string", description: "One load's id (uuid) from list_loads. Omit for the pay-week totals." } },
      },
      access: "read",
      async run(args) {
        const profiles = await client
          .from("employer_pay_profiles")
          .select(PROFILE_COLUMNS)
          .eq("company_id", companyId)
          .is("deleted_at", null);
        if (profiles.error) throw new Error(profiles.error.message);
        const rows = (profiles.data ?? []) as unknown as PayTermsRow[];
        if (rows.length === 0) {
          return "He has no pay terms entered yet, so nothing can be worked out. Offer to set them (set_pay_terms - cents per mile, a percent of the load, or both) or tell him Settings → Pay terms.";
        }
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        const termsFor = (l: { delivery_date: string | null; pickup_date: string | null }) =>
          termsForDate(rows, l.delivery_date ?? l.pickup_date)!.terms;

        if (typeof args.load_id === "string" && args.load_id.length > 0) {
          const { data, error } = await client
            .from("loads")
            .select("*")
            .eq("id", args.load_id)
            .eq("company_id", companyId)
            .is("deleted_at", null)
            .maybeSingle();
          if (error) throw new Error(error.message);
          if (!data) throw new Error(`No load with id ${String(args.load_id)} in his records - use list_loads.`);
          const load = data as Load;
          const terms = termsFor(load);
          return [`Terms used: ${terms.employer_name}, ${describeTerms(terms)}.`, projectionLine(load, projectLoad(terms, load))].join("\n");
        }

        const { data, error } = await client
          .from("loads")
          .select("*")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .in("status", ["confirmed", "completed"])
          .order("delivery_date", { ascending: false, nullsFirst: false })
          .limit(200);
        if (error) throw new Error(error.message);
        const loads = (data ?? []) as Load[];
        const current = termsFor({ delivery_date: today, pickup_date: today });
        const options = { termsFor };
        const week = projectPeriod(current, loads, today, options);
        const previous = projectPreviousPeriod(current, loads, today, options);
        return [
          `Current terms: ${current.employer_name}, ${describeTerms(current)}.`,
          week.weekEndSet ? "" : "(His pay week end is NOT set - weeks run Monday to Sunday until he sets it.)",
          ...periodLines("THIS pay week so far", week),
          "",
          ...periodLines("LAST pay week", previous),
        ]
          .filter((l) => l !== "")
          .join("\n");
      },
    },
  ];
}

/** "check my pay", "what's my pay this week", "how much am I getting paid", "when do I get paid". Owner 2026-11-16. */
export function asksAboutHisPay(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length > 160) return false;
  return (
    /\bmy (pay|paycheck|check|money|earnings)\b/.test(t) ||
    /\b(how much|what)\b.*\b(paid|pay|make|made|earn|earned|earning)\b/.test(t) ||
    /\bwhen\b.*\b(get paid|payday)\b/.test(t) ||
    /^(check )?(pay|paycheck|payday)\??$/.test(t.trim())
  );
}

/**
 * The pay figures, computed in code BEFORE the model answers a pay question - so "check my pay" is answered
 * with the numbers his records support, never "pending" (owner transcript 2026-11-12). Null when the figures
 * could not be read; the model then has the tool as before.
 */
export async function payFiguresBlock(store: BotBrainStore): Promise<string | null> {
  try {
    const tool = buildPayProjectionTools(store).find((t) => t.name === "projected_pay")!;
    const figures = await tool.run({});
    return (
      "HIS PAY, COMPUTED IN CODE FROM HIS RECORDS JUST NOW (answer his pay question with these figures; a range stays a range; " +
      "if a load says what is missing, name exactly that - never say 'pending' when a figure is here):\n" +
      String(figures)
    );
  } catch (err) {
    console.error("[bot] pay figures for the context failed (the model keeps the tool)", err);
    return null;
  }
}

/**
 * This pay week so far, from the same projection projected_pay uses - for the daily check-in
 * (docs/design/abel-do-what-i-ask.md section 6). Null when he has no pay terms or the read fails.
 */
export async function thisPayWeekSoFar(store: BotBrainStore, today: string): Promise<PeriodProjection | null> {
  const profiles = await store.client.from("employer_pay_profiles").select(PROFILE_COLUMNS).eq("company_id", store.companyId).is("deleted_at", null);
  if (profiles.error) return null;
  const rows = (profiles.data ?? []) as unknown as PayTermsRow[];
  if (rows.length === 0) return null;
  const termsFor = (l: { delivery_date: string | null; pickup_date: string | null }) => termsForDate(rows, l.delivery_date ?? l.pickup_date)!.terms;
  const { data, error } = await store.client
    .from("loads")
    .select("*")
    .eq("company_id", store.companyId)
    .is("deleted_at", null)
    .in("status", ["confirmed", "completed"])
    .limit(200);
  if (error) return null;
  return projectPeriod(termsFor({ delivery_date: today, pickup_date: today }), (data ?? []) as Load[], today, { termsFor });
}
