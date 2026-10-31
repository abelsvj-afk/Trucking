// fund_settings upsert (docs/design/driver-mvp.md §9.1). One row per
// company, created on first write - GET /truck-fund reads it
// get-or-default, this route is the get-or-create. Updating the
// sweep rule or target here never touches fund_entries: changing the
// rule changes future suggestions, not recorded history.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { createCrudService } from "@/services/db/crud";
import { updateFundSettingsSchema } from "@/data/schemas/fund-settings";
import type { FundSettings } from "@/types/entities";
import type { FundSettingsView } from "@/types/truck-fund";

const settings = createCrudService<FundSettings>("fund_settings");

export const PATCH = createApiHandler(async (req, ctx) => {
  const body = await validateBody(req, updateFundSettingsSchema);
  const values = body as Record<string, unknown>;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("fund_settings")
    .select("*")
    .is("deleted_at", null)
    .limit(1);
  if (error) throw new Error(error.message);
  const existing = ((data ?? []) as FundSettings[])[0];

  const row = existing
    ? await settings.update(supabase, existing.id, values)
    : await settings.create(supabase, ctx.auth.companyId, values);
  if (!row) throw notFound();

  const view: FundSettingsView = {
    sweep_mode: row.sweep_mode,
    sweep_percent: row.sweep_percent,
    sweep_flat_cents: row.sweep_flat_cents,
    target_band: row.target_band,
    target_cents: row.target_cents,
  };
  return NextResponse.json(view);
});
