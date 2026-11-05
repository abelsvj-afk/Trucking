// The pay-truth slice of the bot store (Abel Intelligence Upgrade, Phase D):
// the pay pin, settlement recording/listing and the weekly pay-report ledger.
// Split out of store.ts (decomposition pass, behavior-preserving): the same
// queries, the same company scoping, composed back into createBotStore.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "./tool-helpers";
import { findPayPin, isPinned, payPinFromProfile, type PayProfileRow } from "./pay-pin";
import { checkSettlementAgainstPin, computeTruePay, type SettlementFigures } from "./pay-truth";
import type { BotBrainStore, SettlementRecordInput, StoredSettlement } from "./store";

/** Phase D: the settlements columns every read selects (migration 00048). */
const SETTLEMENT_COLUMNS =
  "id, issuer_name, period_start, period_end, gross_cents, carrier_cut_cents, net_to_truck_cents, driver_pay_cents, miles_total, miles_loaded, duty_minutes, pin_check, pin_check_detail, created_at";

export type PayStoreMethods = Pick<BotBrainStore, "loadPayPin" | "recordSettlement" | "listSettlements" | "listSettlementsInRange" | "listCompletedLoadsInRange" | "payReportRunForWeek" | "recordPayReportRun">;

export function createPayStore(supabase: SupabaseClient, company: string): PayStoreMethods {
/** Settlement reads degrade gracefully before migration 00048 (empty, like every other not-yet-landed read); writes fail loudly instead - see recordSettlement. */
function settlementsOrThrow(error: { message: string }): StoredSettlement[] {
  if (/settlements/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
    return [];
  }
  throw new Error(error.message);
}

function mapSettlementRows(data: unknown): StoredSettlement[] {
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    issuerName: String(row.issuer_name),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    grossCents: Number(row.gross_cents),
    carrierCutCents: typeof row.carrier_cut_cents === "number" ? row.carrier_cut_cents : null,
    netToTruckCents: typeof row.net_to_truck_cents === "number" ? row.net_to_truck_cents : null,
    driverPayCents: Number(row.driver_pay_cents),
    milesTotal: typeof row.miles_total === "number" ? row.miles_total : null,
    milesLoaded: typeof row.miles_loaded === "number" ? row.miles_loaded : null,
    dutyMinutes: typeof row.duty_minutes === "number" ? row.duty_minutes : null,
    pinCheck: String(row.pin_check),
    pinCheckDetail: typeof row.pin_check_detail === "string" ? row.pin_check_detail : null,
    createdAt: String(row.created_at),
  }));
}

/**
 * On-duty minutes (driving + on_duty - sleeper and off-duty are
 * not duty time) inside a settlement period, from his paper-log
 * helper rows. Each log runs until the next one starts; the log
 * that began before the period carries in. Dates are read as UTC
 * day boundaries - duty minutes feed an informational $/hour, and
 * the helper was never the legal record (§6 framing stands).
 * Null when he has no logs in or before the period.
 */
async function dutyMinutesInRange(periodStart: string, periodEnd: string): Promise<number | null> {
  const rangeStart = Date.parse(`${periodStart}T00:00:00.000Z`);
  const rangeEnd = Date.parse(`${periodEnd}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  const { data, error } = await supabase
    .from("duty_logs")
    .select("started_at, duty_status")
    .eq("company_id", company)
    .is("deleted_at", null)
    .lt("started_at", new Date(rangeEnd).toISOString())
    .order("started_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { started_at: string; duty_status: string }[];
  if (rows.length === 0) return null;
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.duty_status !== "driving" && row.duty_status !== "on_duty") continue;
    const segStart = Math.max(Date.parse(row.started_at), rangeStart);
    const segEnd = Math.min(
      i + 1 < rows.length ? Date.parse(rows[i + 1]!.started_at) : rangeEnd,
      rangeEnd,
    );
    if (segEnd > segStart) total += Math.round((segEnd - segStart) / 60000);
  }
  return total;
}

  return {
    // --- Phase D (pay truth) ---

    async loadPayPin() {
      // Current business_fact rows only: valid_to closes superseded
      // pins (Lane 2 lifecycle). Before migration 00029 lands the
      // lifecycle columns don't exist - fall back to newest-first,
      // where findPayPin takes the first (newest) pin line.
      const run = (withLifecycle: boolean) => {
        let q = supabase
          .from("bot_memories")
          .select("content")
          .eq("company_id", company)
          .eq("kind", "business_fact")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(100);
        if (withLifecycle) q = q.is("valid_to", null);
        return q;
      };
      let result = await run(true);
      if (result.error && isMissingColumnError(result.error)) result = await run(false);
      if (result.error) throw new Error(result.error.message);
      const remembered = findPayPin((result.data ?? []) as { content: string }[]);
      if (isPinned(remembered)) return remembered;
      // No remembered pin: fall back to the owner's pay-terms profile (00063).
      // A missing table or no usable profile is simply "still unknown".
      const profile = await supabase
        .from("employer_pay_profiles")
        .select("employer_name, rate_cents_per_mile, mile_basis, worker_type, fuel_paid_by, effective_from")
        .eq("company_id", company)
        .is("deleted_at", null)
        .is("effective_to", null)
        .order("effective_from", { ascending: false })
        .limit(1);
      if (profile.error) return remembered;
      return payPinFromProfile(((profile.data ?? []) as PayProfileRow[])[0]);
    },

    async recordSettlement(input: SettlementRecordInput) {
      const dutyMinutes =
        input.dutyMinutes ??
        (await dutyMinutesInRange(input.periodStart, input.periodEnd));
      const figures: SettlementFigures = { ...input, dutyMinutes };
      const pin = await this.loadPayPin();
      const linkedLoadIds = [
        ...new Set(input.lines.map((l) => l.loadId).filter((id): id is string => Boolean(id))),
      ];
      const check = checkSettlementAgainstPin(figures, pin, linkedLoadIds.length);
      const truePay = computeTruePay(figures, pin);

      const { data, error } = await supabase
        .from("settlements")
        .insert({
          company_id: company,
          issuer_name: input.issuerName,
          period_start: input.periodStart,
          period_end: input.periodEnd,
          gross_cents: input.grossCents,
          carrier_cut_cents: input.carrierCutCents,
          net_to_truck_cents: input.netToTruckCents,
          driver_pay_cents: input.driverPayCents,
          miles_total: input.milesTotal,
          miles_loaded: input.milesLoaded,
          duty_minutes: dutyMinutes,
          source_document_id: input.sourceDocumentId ?? null,
          pin_check: check.status,
          pin_check_detail: check.detail,
          tax_setaside_cents: truePay.taxSetasideCents,
          spendable_cents: truePay.spendableCents,
          effective_cpm_cents: truePay.effectiveCpmCents,
          effective_hourly_cents: truePay.effectiveHourlyCents,
          other_model_pay_cents: truePay.otherModelPayCents,
          notes: input.notes ?? null,
        })
        .select("id")
        .single();
      if (error) {
        if (/settlements/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
          throw new Error(
            "Settlements aren't available yet - migration 00048 hasn't been applied to the database, so nothing was recorded.",
          );
        }
        throw new Error(error.message);
      }
      const settlementId = (data as { id: string }).id;

      if (input.lines.length > 0) {
        const { error: linesError } = await supabase.from("settlement_lines").insert(
          input.lines.map((line) => ({
            company_id: company,
            settlement_id: settlementId,
            kind: line.kind,
            label: line.label,
            amount_cents: line.amountCents,
            load_id: line.loadId ?? null,
          })),
        );
        if (linesError) throw new Error(linesError.message);
      }
      if (linkedLoadIds.length > 0) {
        const { error: linksError } = await supabase.from("settlement_load_links").insert(
          linkedLoadIds.map((loadId) => ({
            company_id: company,
            settlement_id: settlementId,
            load_id: loadId,
            matched_by: "line",
          })),
        );
        if (linksError) throw new Error(linksError.message);
      }

      return {
        id: settlementId,
        pinCheck: check.status,
        pinCheckDetail: check.detail,
        truePayLines: truePay.lines,
      };
    },

    async listSettlements(limit = 10) {
      const { data, error } = await supabase
        .from("settlements")
        .select(SETTLEMENT_COLUMNS)
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("period_end", { ascending: false })
        .limit(limit);
      if (error) return settlementsOrThrow(error);
      return mapSettlementRows(data);
    },

    async listSettlementsInRange(startDate: string, endDate: string) {
      const { data, error } = await supabase
        .from("settlements")
        .select(SETTLEMENT_COLUMNS)
        .eq("company_id", company)
        .is("deleted_at", null)
        .lte("period_start", endDate)
        .gte("period_end", startDate)
        .order("period_end", { ascending: false })
        .limit(50);
      if (error) return settlementsOrThrow(error);
      return mapSettlementRows(data);
    },

    async listCompletedLoadsInRange(startDate: string, endDate: string) {
      const { data, error } = await supabase
        .from("loads")
        .select("origin, destination, rate_cents, miles")
        .eq("company_id", company)
        .eq("status", "completed")
        .is("deleted_at", null)
        .gte("delivery_date", startDate)
        .lte("delivery_date", endDate)
        .limit(100);
      if (error) throw new Error(error.message);
      return ((data ?? []) as { origin: string; destination: string; rate_cents: number | null; miles: number | null }[]).map(
        (row) => ({
          origin: row.origin,
          destination: row.destination,
          rateCents: row.rate_cents,
          miles: row.miles,
        }),
      );
    },

    async payReportRunForWeek(weekStart: string) {
      const { data, error } = await supabase
        .from("pay_report_runs")
        .select("week_start, sent, figures, created_at")
        .eq("company_id", company)
        .eq("week_start", weekStart)
        .is("deleted_at", null)
        .limit(1);
      if (error) {
        // Graceful absence: migration 00048 not applied yet - the
        // report job simply has no state and stays quiet.
        if (/pay_report_runs/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
          return null;
        }
        throw new Error(error.message);
      }
      const row = (data ?? [])[0] as
        | { week_start: string; sent: boolean; figures: { closedEmpty?: unknown } | null; created_at: string }
        | undefined;
      return row
        ? {
            weekStart: row.week_start,
            sent: row.sent,
            closedEmpty: row.figures?.closedEmpty === true,
            createdAt: row.created_at,
          }
        : null;
    },

    async recordPayReportRun(weekStart: string, sent: boolean, figures: Record<string, unknown>) {
      // Upsert on the week's unique key: a retry after a failed send
      // updates the same marker instead of piling up run rows.
      const { error } = await supabase.from("pay_report_runs").upsert(
        {
          company_id: company,
          week_start: weekStart,
          sent,
          figures,
          deleted_at: null,
        },
        { onConflict: "company_id,week_start" },
      );
      if (error) throw new Error(error.message);
    },

  };
}
