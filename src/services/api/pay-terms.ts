// The owner's dated pay terms, read once the same way for every server surface that needs to value a load from miles.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PayTermsRow } from "@/lib/paycheck";

export const PAY_TERMS_COLUMNS =
  "employer_name, rate_cents_per_mile, mile_basis, worker_type, tax_set_aside_bps, percent_of_load_bps, pay_week_ends_on, statement_weekday, payday_weekday, effective_from, effective_to";

/** Pay terms for the company, or [] when none are set or the read fails (callers then show the figure as unestimated, never invent one). */
export async function fetchPayTerms(client: SupabaseClient, companyId: string): Promise<PayTermsRow[]> {
  const { data, error } = await client.from("employer_pay_profiles").select(PAY_TERMS_COLUMNS).eq("company_id", companyId).is("deleted_at", null);
  if (error) return [];
  return (data ?? []) as PayTermsRow[];
}
