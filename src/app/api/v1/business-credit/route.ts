import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { ApiError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { canAccessRoute, loadPageAccessRules } from "@/lib/page-access";
import { loadBusinessCredit } from "@/services/business-credit/store";
import type { BusinessCreditData } from "@/lib/business-credit";

/**
 * GET /api/v1/business-credit — the Business Credit page's data
 * (docs/design/business-credit.md). OWNER-ONLY, enforced HERE on the
 * server through the one central check (src/lib/page-access.ts): the
 * nav hiding the link is presentation, this 403 is the enforcement.
 * Answers `available: false` when migration 00087 hasn't landed yet.
 */
export const GET = createApiHandler(async (_req, { auth }) => {
  const supabase = await createClient();
  const rules = await loadPageAccessRules(supabase);
  if (!canAccessRoute(rules, auth.role, "/more/business-credit")) {
    throw new ApiError(
      403,
      "forbidden",
      "Business Credit is owner-only business.",
    );
  }
  const data: BusinessCreditData = await loadBusinessCredit(
    supabase,
    auth.companyId,
  );
  return NextResponse.json(data);
});
