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
import { createBotStore } from "@/services/bot/store";
import { stageRecordables } from "@/services/bot/stage-recordables";

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

  // §11: recordables spotted in the message are staged as a
  // propose->yes batch on the owner's session store (channel "web")
  // - the page shows what was staged; approving happens in the
  // Assistant, whose turn resolves pending batches in code. The
  // suggestion itself stays the pure workup either way.
  let recordables: {
    staged: string[];
    rejected: { summary: string; reason: string }[];
    blocked_by_pending: boolean;
  } = { staged: [], rejected: [], blocked_by_pending: false };
  if (suggestion.recordable_items.length > 0) {
    const supabase = await createClient();
    const store = createBotStore(supabase, ctx.auth.companyId, "web");
    const outcome = await stageRecordables(store, body.message, suggestion.recordable_items);
    recordables = {
      staged: outcome.proposals.map((p) => p.summary),
      rejected: outcome.rejected,
      blocked_by_pending: outcome.blockedByPending,
    };
  }
  return NextResponse.json({ ...suggestion, recordables });
});
