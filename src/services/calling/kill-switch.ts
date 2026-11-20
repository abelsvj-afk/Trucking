// The outbound-calling kill switch, read live (audit F-005/F-016). One
// check, used by the dialer itself, so EVERY route to a dial (the place_call
// tool, the webhook's queue drain, any retry) passes it right before Telnyx
// is called — switching calling off in Settings stops queued calls too.
// Global AI off, no `outbound_calling` row, or a failed read = off (fail closed).

import type { SupabaseClient } from "@supabase/supabase-js";
import { OUTBOUND_CALLING_CAPABILITY } from "./config";

export type CallingAllowed = { ok: true } | { ok: false; error: string };

const CHECK_FAILED = "I couldn't check whether calling is switched on.";

export async function canPlaceOutboundCall(client: SupabaseClient, companyId: string): Promise<CallingAllowed> {
  try {
    const [companyRes, capRes] = await Promise.all([
      client.from("companies").select("ai_globally_disabled").eq("id", companyId).single(),
      client
        .from("ai_capability_settings")
        .select("enabled")
        .eq("company_id", companyId)
        .eq("capability", OUTBOUND_CALLING_CAPABILITY)
        .maybeSingle(),
    ]);
    if (companyRes.error) return { ok: false, error: CHECK_FAILED };
    if ((companyRes.data as { ai_globally_disabled?: boolean } | null)?.ai_globally_disabled) {
      return { ok: false, error: "All AI capabilities are switched off, so I can't call." };
    }
    if (capRes.error) return { ok: false, error: CHECK_FAILED };
    if ((capRes.data as { enabled?: boolean } | null)?.enabled !== true) {
      return { ok: false, error: "Outbound calling is switched off. Switch it on in Settings → Abel and AI first." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: CHECK_FAILED };
  }
}
