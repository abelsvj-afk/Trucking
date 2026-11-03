// HOS carrier configuration (Reliability Unit B - design B.5, F-015),
// per docs/api-contracts.md. Read/write from the normal authenticated
// owner session, mirroring the ai-settings route's shape.
//
// The values are CARRIER-SPECIFIED: the cycle, the period anchor, the
// restart policy, and the timezone the anchor is read in. Until the
// carrier's actual rules are entered, the stored values are the
// owner-approved provisional defaults (migration 00042) and the UI
// labels them as such - they are never presented as verified carrier
// facts.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { ApiError } from "@/services/api/errors";
import { hosSettingsPatchSchema } from "@/data/schemas/hos-settings";
import { createClient } from "@/services/db/server";
import { loadHosConfig } from "@/services/api/hos-config";
import type { HosSettings } from "@/types/hos-settings";

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const { settings } = await loadHosConfig(supabase, ctx.auth.companyId);
  return NextResponse.json(settings);
});

export const PATCH = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const parsed = hosSettingsPatchSchema.safeParse(json);
  if (!parsed.success) {
    // Field-named errors (design B.5): the response says WHICH setting
    // was refused and why, not just that the body was invalid.
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "One or more HOS settings were rejected.",
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }

  const patch: Partial<HosSettings> = parsed.data;
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from("companies")
      .update(patch)
      .eq("id", ctx.auth.companyId);
    if (error) {
      if ((error as { code?: string }).code === "42703") {
        throw new ApiError(
          500,
          "HOS_CONFIG_UNAVAILABLE",
          "HOS settings storage is not available yet (migration 00042 has not been applied).",
        );
      }
      throw new ApiError(500, "HOS_CONFIG_UNAVAILABLE", "The HOS settings could not be saved.");
    }
  }

  const { settings } = await loadHosConfig(supabase, ctx.auth.companyId);
  return NextResponse.json(settings);
});
