// GAP-14 (Fresh-Eyes Register 2026-11-02) — scorecard assembly:
// fetch the broker's loads, invoices, detention stamps, and linked
// dispatch exchanges, then let lib/broker-scorecard.ts do the math.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeBrokerScorecard,
  type BrokerScorecard,
} from "@/lib/broker-scorecard";
import { easternDate } from "@/lib/day-wrap";
import type { DetentionStamp, Load, LoadInvoice } from "@/types/entities";

export async function getBrokerScorecard(
  supabase: SupabaseClient,
  companyId: string,
  brokerId: string,
): Promise<BrokerScorecard | null> {
  const { data: broker, error: brokerError } = await supabase
    .from("brokers")
    .select("id")
    .eq("company_id", companyId)
    .eq("id", brokerId)
    .is("deleted_at", null)
    .maybeSingle();
  if (brokerError) throw new Error(brokerError.message);
  if (!broker) return null;

  const [loadsResult, invoicesResult, exchangesResult] = await Promise.all([
    supabase
      .from("loads")
      .select("*")
      .eq("company_id", companyId)
      .eq("broker_id", brokerId)
      .is("deleted_at", null),
    supabase
      .from("load_invoices")
      .select("*")
      .eq("company_id", companyId)
      .eq("broker_id", brokerId)
      .is("deleted_at", null),
    supabase
      .from("dispatch_exchanges")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("broker_id", brokerId)
      .is("deleted_at", null),
  ]);
  if (loadsResult.error) throw new Error(loadsResult.error.message);
  // Invoices arrive with migration 00052 — tolerate its absence.
  const invoices = invoicesResult.error ? [] : ((invoicesResult.data ?? []) as LoadInvoice[]);
  const loads = (loadsResult.data ?? []) as Load[];

  const stampsByLoadId = new Map<string, DetentionStamp[]>();
  if (loads.length > 0) {
    const { data: stamps, error: stampsError } = await supabase
      .from("detention_stamps")
      .select("*")
      .eq("company_id", companyId)
      .in("load_id", loads.map((l) => l.id))
      .is("deleted_at", null);
    if (!stampsError) {
      for (const stamp of (stamps ?? []) as DetentionStamp[]) {
        const list = stampsByLoadId.get(stamp.load_id) ?? [];
        list.push(stamp);
        stampsByLoadId.set(stamp.load_id, list);
      }
    }
  }

  return computeBrokerScorecard(brokerId, {
    loads,
    invoices,
    stampsByLoadId,
    dispatchExchanges: exchangesResult.count ?? 0,
    today: easternDate(new Date()),
  });
}
