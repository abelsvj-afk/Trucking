// Driver MVP (docs/design/driver-mvp.md §2). Stateless: validates the
// pasted message, checks the dispatch_helper kill switches
// (docs/governance.md - global first, then per-capability, both fail
// closed), calls the shared dispatch service, returns the suggestion.
// Nothing is stored here; saving an exchange is the separate
// /api/v1/dispatch-exchanges resource, on the owner's explicit tap.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { ApiError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { DISPATCH_HELPER_CAPABILITY, suggestDispatchReply } from "@/services/ai/dispatch";

const dispatchSuggestRequestSchema = z.object({
  message: z.string().min(1, "message is required.").max(8000),
  context: z.string().max(2000).optional(),
});

async function assertDispatchHelperEnabled(companyId: string): Promise<void> {
  const supabase = await createClient();
  const [companyResult, capabilityResult] = await Promise.all([
    supabase.from("companies").select("ai_globally_disabled").eq("id", companyId).single(),
    supabase
      .from("ai_capability_settings")
      .select("enabled")
      .eq("company_id", companyId)
      .eq("capability", DISPATCH_HELPER_CAPABILITY)
      .maybeSingle(),
  ]);

  if (companyResult.error) throw new Error(companyResult.error.message);
  if (capabilityResult.error) throw new Error(capabilityResult.error.message);

  const globallyDisabled =
    (companyResult.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled ?? false;
  // No row = off, fails closed - same convention as /api/v1/ai-settings.
  const capabilityEnabled =
    (capabilityResult.data as { enabled: boolean } | null)?.enabled ?? false;

  if (globallyDisabled || !capabilityEnabled) {
    throw new ApiError(
      403,
      "AI_CAPABILITY_DISABLED",
      "The dispatch helper is turned off. Enable it in More → Account & settings.",
    );
  }
}

export const POST = createApiHandler(async (req, ctx) => {
  const body = await validateBody(req, dispatchSuggestRequestSchema);
  await assertDispatchHelperEnabled(ctx.auth.companyId);

  const suggestion = await suggestDispatchReply(new OpenAiProvider(), {
    message: body.message,
    context: body.context,
  });
  return NextResponse.json(suggestion);
});
