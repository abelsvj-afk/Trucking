// The deep_research capability check for the research read/write
// surfaces (Home News Banner design §§4-5). Same semantics as the
// bot store's shared capabilityEnabled() helper (Lane 1): the
// company global kill switch wins, then the per-capability row; no
// row = off. Fails CLOSED on any read error - a banner or pull that
// cannot verify the switch stays hidden/refused, never guesses on.
// The capability key is DEEP_RESEARCH_CAPABILITY in
// services/research/run-research.ts (kept as a literal here so this
// read path doesn't pull the whole engine module into its bundle).

import { createClient } from "@/services/db/server";

const DEEP_RESEARCH_CAPABILITY = "deep_research";

type SessionClient = Awaited<ReturnType<typeof createClient>>;

export async function isDeepResearchEnabled(
  supabase: SessionClient,
  companyId: string,
): Promise<boolean> {
  try {
    const [companyResult, capabilityResult] = await Promise.all([
      supabase.from("companies").select("ai_globally_disabled").eq("id", companyId).single(),
      supabase
        .from("ai_capability_settings")
        .select("enabled")
        .eq("company_id", companyId)
        .eq("capability", DEEP_RESEARCH_CAPABILITY)
        .maybeSingle(),
    ]);
    if (companyResult.error || capabilityResult.error) return false;

    const globallyDisabled =
      (companyResult.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled ??
      false;
    const enabled = (capabilityResult.data as { enabled: boolean } | null)?.enabled ?? false;
    return !globallyDisabled && enabled;
  } catch {
    return false;
  }
}
