import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BusinessCreditAccount,
  BusinessCreditEvent,
  BusinessCreditProfile,
} from "@/types/entities";

/**
 * Business Credit data access (migration 00087;
 * docs/design/business-credit.md). Every read degrades honestly when
 * the tables don't exist yet (00087 not applied): `available: false`,
 * empty lists — the page and Abel's tools say "not switched on yet"
 * instead of erroring, the 00084 pattern.
 */

export interface BusinessCreditData {
  available: boolean;
  profile: BusinessCreditProfile | null;
  accounts: BusinessCreditAccount[];
  events: BusinessCreditEvent[];
}

const PROFILE_COLS =
  "id, company_id, legal_name, filed_name, duns, sunbiz_doc, sunbiz_status, registered_address, business_email, created_at, updated_at, deleted_at";
const ACCOUNT_COLS =
  "id, company_id, vendor, vendor_key, status, reports_to, next_action, payment_state, next_due_date, amount_due_cents, match_senders, notes, sort_order, created_at, updated_at, deleted_at";
const EVENT_COLS =
  "id, company_id, account_id, source, signal, email_message_id, email_server_message_id, summary, detail, buzz_state, buzz_text, buzz_sent_at, created_at, updated_at, deleted_at";

export async function loadBusinessCredit(
  client: SupabaseClient,
  companyId: string,
  eventLimit = 12,
): Promise<BusinessCreditData> {
  const empty: BusinessCreditData = {
    available: false,
    profile: null,
    accounts: [],
    events: [],
  };
  try {
    const [profileRes, accountsRes, eventsRes] = await Promise.all([
      client
        .from("business_credit_profiles")
        .select(PROFILE_COLS)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .limit(1)
        .maybeSingle(),
      client
        .from("business_credit_accounts")
        .select(ACCOUNT_COLS)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .order("sort_order", { ascending: true }),
      client
        .from("business_credit_events")
        .select(EVENT_COLS)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(eventLimit),
    ]);
    if (profileRes.error || accountsRes.error) return empty;
    return {
      available: true,
      profile: (profileRes.data as BusinessCreditProfile | null) ?? null,
      accounts: (accountsRes.data ?? []) as BusinessCreditAccount[],
      events: eventsRes.error
        ? []
        : ((eventsRes.data ?? []) as BusinessCreditEvent[]),
    };
  } catch {
    return empty;
  }
}

export interface BusinessCreditStore {
  loadAccounts(): Promise<BusinessCreditAccount[] | null>;
  /** The watch event already recorded for this (account, email), if any. */
  findWatchEvent(
    accountId: string,
    emailMessageRowId: string,
  ): Promise<{ id: string } | null>;
  applyPaymentUpdate(
    accountId: string,
    patch: {
      payment_state?: string;
      next_due_date?: string | null;
      amount_due_cents?: number | null;
    },
  ): Promise<void>;
  recordEvent(row: Record<string, unknown>): Promise<{ id: string } | null>;
  loadHeldEvents(): Promise<BusinessCreditEvent[]>;
  markBuzzSent(eventId: string, atIso: string): Promise<void>;
  markBuzzHeld(eventId: string): Promise<void>;
  latestDutyStatus(): Promise<string | null>;
}

export function createBusinessCreditStore(
  client: SupabaseClient,
  companyId: string,
): BusinessCreditStore {
  return {
    async loadAccounts() {
      try {
        const { data, error } = await client
          .from("business_credit_accounts")
          .select(ACCOUNT_COLS)
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("sort_order", { ascending: true });
        if (error) return null;
        return (data ?? []) as BusinessCreditAccount[];
      } catch {
        return null;
      }
    },
    async findWatchEvent(accountId, emailMessageRowId) {
      const { data, error } = await client
        .from("business_credit_events")
        .select("id")
        .eq("company_id", companyId)
        .eq("account_id", accountId)
        .eq("email_message_id", emailMessageRowId)
        .eq("source", "email_watch")
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      return { id: String(data.id) };
    },
    async applyPaymentUpdate(accountId, patch) {
      const { error } = await client
        .from("business_credit_accounts")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("company_id", companyId)
        .eq("id", accountId);
      if (error) throw error;
    },
    async recordEvent(row) {
      const { data, error } = await client
        .from("business_credit_events")
        .insert({ company_id: companyId, ...row })
        .select("id")
        .single();
      if (error || !data) return null;
      return { id: String(data.id) };
    },
    async loadHeldEvents() {
      const { data, error } = await client
        .from("business_credit_events")
        .select(EVENT_COLS)
        .eq("company_id", companyId)
        .eq("buzz_state", "held")
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(20);
      if (error) return [];
      return (data ?? []) as BusinessCreditEvent[];
    },
    async markBuzzSent(eventId, atIso) {
      await client
        .from("business_credit_events")
        .update({ buzz_state: "sent", buzz_sent_at: atIso })
        .eq("company_id", companyId)
        .eq("id", eventId);
    },
    async markBuzzHeld(eventId) {
      await client
        .from("business_credit_events")
        .update({ buzz_state: "held", buzz_sent_at: null })
        .eq("company_id", companyId)
        .eq("id", eventId);
    },
    async latestDutyStatus() {
      try {
        const { data } = await client
          .from("duty_logs")
          .select("duty_status")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return (data?.duty_status as string | undefined) ?? null;
      } catch {
        return null;
      }
    },
  };
}
