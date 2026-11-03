// GAP-08 (Fresh-Eyes Register 2026-11-02) — day-wrap assembly.
//
// Fetches the day's rows (a generous UTC window, bucketed by
// America/New_York calendar date in code — the driver's day, not
// UTC's; the Reliability program's timezone rules are honored by
// never letting a UTC midnight split his evening) and feeds them
// to lib/day-wrap.ts's pure pass. Used by the API route, the Home
// card, and Abel's get_day_wrap tool (which passes its service-
// role client + company id; RLS-scoped callers pass companyId too
// and the queries filter on it either way).

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDayWrap, easternDate, type DayWrapItem } from "@/lib/day-wrap";
import { computeDetention } from "@/lib/detention";
import { computePaperwork } from "@/lib/paperwork";
import type { DetentionStamp, DutyLog, Load } from "@/types/entities";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getDayWrap(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
  now: Date = new Date(),
): Promise<{ date: string; items: DayWrapItem[] }> {
  const dayStartUtc = Date.parse(`${date}T00:00:00Z`);
  const windowFrom = new Date(dayStartUtc - 2 * DAY_MS).toISOString();
  const windowTo = new Date(dayStartUtc + 3 * DAY_MS).toISOString();
  const onDate = (iso: string) => easternDate(new Date(iso)) === date;

  const [logsResult, fuelResult, loadsResult, pendingResult, credentialsResult, invoicesResult, followupsResult] = await Promise.all([
    supabase
      .from("duty_logs")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("started_at", windowFrom)
      .lt("started_at", windowTo)
      .order("started_at", { ascending: true }),
    supabase
      .from("fuel_purchases")
      .select("id, purchased_at")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("purchased_at", windowFrom)
      .lt("purchased_at", windowTo),
    supabase
      .from("loads")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("bot_pending_actions")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .is("deleted_at", null),
    // GAP-11/12/14 inputs. These tables arrive with migrations
    // 00048/00049/00051 — a missing table must never break the
    // wrap, so their errors are tolerated (treated as empty).
    supabase
      .from("credentials")
      .select("label, kind, expires_on")
      .eq("company_id", companyId)
      .is("deleted_at", null),
    supabase
      .from("load_invoices")
      .select("load_id, amount_cents, paid_amount_cents, due_date")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .lt("due_date", date),
    supabase
      .from("broker_followups")
      .select("broker_id, note, due_on")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .is("done_at", null)
      .lte("due_on", date)
      .order("due_on", { ascending: true })
      .limit(5),
  ]);
  if (logsResult.error) throw new Error(logsResult.error.message);
  if (fuelResult.error) throw new Error(fuelResult.error.message);
  if (loadsResult.error) throw new Error(loadsResult.error.message);

  const dutyLogs = ((logsResult.data ?? []) as DutyLog[]).filter((l) => onDate(l.started_at));
  const odometers = dutyLogs
    .map((l) => l.odometer)
    .filter((o): o is number => typeof o === "number");
  const odometerMilesToday =
    odometers.length >= 2 ? Math.max(...odometers) - Math.min(...odometers) : null;
  const fuelLoggedToday = ((fuelResult.data ?? []) as { purchased_at: string }[]).some((f) =>
    onDate(f.purchased_at),
  );
  const loads = (loadsResult.data ?? []) as Load[];
  const hasActiveLoad = loads.some(
    (l) => l.status === "confirmed" || l.pickup_date === date || l.delivery_date === date,
  );

  // Paperwork + detention for the loads this day touched:
  // delivered today, or with a departure stamp today.
  const deliveredToday = loads.filter((l) => l.delivery_date === date);
  const paperwork: { loadLabel: string; state: ReturnType<typeof computePaperwork> }[] = [];
  const detention: { loadLabel: string; summary: ReturnType<typeof computeDetention> }[] = [];
  for (const load of deliveredToday.slice(0, 10)) {
    const [docsResult, expensesResult, stampsResult] = await Promise.all([
      supabase
        .from("documents")
        .select("id, doc_type")
        .eq("company_id", companyId)
        .eq("related_entity_type", "load")
        .eq("related_entity_id", load.id),
      supabase
        .from("expenses")
        .select("category, description")
        .eq("company_id", companyId)
        .eq("load_id", load.id)
        .is("deleted_at", null),
      supabase
        .from("detention_stamps")
        .select("*")
        .eq("company_id", companyId)
        .eq("load_id", load.id)
        .is("deleted_at", null),
    ]);
    if (docsResult.error) throw new Error(docsResult.error.message);
    if (expensesResult.error) throw new Error(expensesResult.error.message);
    if (stampsResult.error) throw new Error(stampsResult.error.message);
    const label = `${load.origin} → ${load.destination}`;
    paperwork.push({
      loadLabel: label,
      state: computePaperwork(
        load,
        (docsResult.data ?? []) as { id: string; doc_type: string | null }[],
        (expensesResult.data ?? []) as unknown as Pick<
          import("@/types/entities").Expense,
          "category" | "description"
        >[],
      ),
    });
    const stamps = (stampsResult.data ?? []) as DetentionStamp[];
    if (stamps.some((s) => s.stamp_type === "departure" && onDate(s.occurred_at))) {
      detention.push({ loadLabel: label, summary: computeDetention(load, stamps) });
    }
  }

  // GAP-11: credential alerts on the 60/30/7 ladder.
  const { credentialAlerts: computeCredentialAlerts, describeCredentialAlert } = await import(
    "@/lib/credentials"
  );
  const credentialAlerts = credentialsResult.error
    ? []
    : computeCredentialAlerts(
        (credentialsResult.data ?? []) as { label: string; kind: string; expires_on: string }[],
        date,
      ).map(describeCredentialAlert);

  // GAP-12: overdue invoices, labeled by their load's lane.
  const loadById = new Map(loads.map((l) => [l.id, l]));
  const overdueInvoices = invoicesResult.error
    ? []
    : ((invoicesResult.data ?? []) as {
        load_id: string;
        amount_cents: number;
        paid_amount_cents: number;
        due_date: string;
      }[])
        .filter((i) => i.paid_amount_cents < i.amount_cents)
        .map((i) => {
          const load = loadById.get(i.load_id);
          return {
            loadLabel: load ? `${load.origin} → ${load.destination}` : "A load",
            daysLate: Math.floor(
              (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${i.due_date}T00:00:00Z`)) / 86_400_000,
            ),
            outstandingCents: i.amount_cents - i.paid_amount_cents,
          };
        });

  // GAP-14: due follow-ups, named by broker.
  let dueFollowups: { brokerName: string; note: string; dueOn: string }[] = [];
  if (!followupsResult.error && (followupsResult.data ?? []).length > 0) {
    const rows = (followupsResult.data ?? []) as { broker_id: string; note: string; due_on: string }[];
    const brokerIds = [...new Set(rows.map((r) => r.broker_id))];
    const { data: brokerRows } = await supabase
      .from("brokers")
      .select("id, name")
      .eq("company_id", companyId)
      .in("id", brokerIds);
    const brokerName = new Map(((brokerRows ?? []) as { id: string; name: string }[]).map((b) => [b.id, b.name]));
    dueFollowups = rows.map((r) => ({
      brokerName: brokerName.get(r.broker_id) ?? "A broker",
      note: r.note,
      dueOn: r.due_on,
    }));
  }

  const items = buildDayWrap({
    date,
    dutyLogs,
    odometerMilesToday,
    fuelLoggedToday,
    hasActiveLoad,
    paperwork,
    detention,
    pendingProposals: pendingResult.count ?? 0,
    credentialAlerts,
    overdueInvoices,
    dueFollowups,
    now,
  });
  return { date, items };
}
