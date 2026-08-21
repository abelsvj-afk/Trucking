// Task 4.6 (TASKS.md), per docs/api-contracts.md and docs/governance.md's
// two-tiered revocation requirement. Read/write from the normal
// authenticated owner session (unlike the scheduled job's separate scoped
// credential) - flipping a switch is the owner's own action.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { aiSettingsPatchSchema, KNOWN_CAPABILITIES } from "@/data/schemas/ai-settings";

async function getAiSettings(supabase: SupabaseClient, companyId: string) {
  const [companyResult, capabilitiesResult] = await Promise.all([
    supabase.from("companies").select("ai_globally_disabled").eq("id", companyId).single(),
    supabase.from("ai_capability_settings").select("capability, enabled").eq("company_id", companyId),
  ]);

  if (companyResult.error) throw new Error(companyResult.error.message);
  if (capabilitiesResult.error) throw new Error(capabilitiesResult.error.message);

  const enabledByCapability = new Map(
    ((capabilitiesResult.data ?? []) as { capability: string; enabled: boolean }[]).map((row) => [
      row.capability,
      row.enabled,
    ]),
  );

  // A capability with no row is off - fails closed, per CLAUDE.md and
  // docs/schemas.md's ai_capability_settings note.
  const capabilities = Object.fromEntries(
    KNOWN_CAPABILITIES.map((capability) => [capability, enabledByCapability.get(capability) ?? false]),
  );

  return {
    globally_disabled: (companyResult.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled ?? false,
    capabilities,
  };
}

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const settings = await getAiSettings(supabase, ctx.auth.companyId);
  return NextResponse.json(settings);
});

export const PATCH = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, aiSettingsPatchSchema);

  if (body.globally_disabled !== undefined) {
    const { error } = await supabase
      .from("companies")
      .update({ ai_globally_disabled: body.globally_disabled })
      .eq("id", ctx.auth.companyId);
    if (error) throw new Error(error.message);
  }

  if (body.capabilities) {
    for (const [capability, enabled] of Object.entries(body.capabilities)) {
      const { error } = await supabase.from("ai_capability_settings").upsert(
        {
          company_id: ctx.auth.companyId,
          capability,
          enabled,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "company_id,capability" },
      );
      if (error) throw new Error(error.message);
    }
  }

  const settings = await getAiSettings(supabase, ctx.auth.companyId);
  return NextResponse.json(settings);
});
