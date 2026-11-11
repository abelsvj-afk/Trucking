// Person preferences for the signed-in owner (UI/UX Phase 4, spec
// 2026-11-10 §2.4): the web read/write door onto person_preferences
// (migration 00077) for subject_type='owner', driver_id null — the
// same rows the bot reads with subject_type='owner'. First consumer:
// Home's map collapse choice (key "home_map_collapsed").
//
// Auth/tenant pattern copied from src/app/api/v1/hos-settings/route.ts:
// createApiHandler supplies the authenticated context, every query is
// scoped to ctx.auth.companyId explicitly (the table's RLS tenant
// policy via private.current_company_id() is the backstop), and a
// storage failure is an explicit 500 — never a silent no-save.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { ApiError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";

interface PreferenceRow {
  key: string;
  value: unknown;
}

async function loadPreferences(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  key?: string,
): Promise<PreferenceRow[]> {
  let query = supabase
    .from("person_preferences")
    .select("key, value")
    .eq("company_id", companyId)
    .eq("subject_type", "owner")
    .is("driver_id", null)
    .is("deleted_at", null);
  if (key !== undefined) query = query.eq("key", key);
  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "PREFERENCES_UNAVAILABLE", "Your preferences could not be loaded.");
  }
  return (data ?? []) as PreferenceRow[];
}

export const GET = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const key = new URL(req.url).searchParams.get("key") ?? undefined;
  const rows = await loadPreferences(supabase, ctx.auth.companyId, key);
  if (key !== undefined) {
    const row = rows.find((r) => r.key === key);
    return NextResponse.json({ key, value: row ? row.value : null });
  }
  const preferences: Record<string, unknown> = {};
  for (const row of rows) preferences[row.key] = row.value;
  return NextResponse.json({ preferences });
});

export const PUT = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const body = (typeof json === "object" && json !== null ? json : {}) as {
    key?: unknown;
    value?: unknown;
  };
  if (typeof body.key !== "string" || body.key.trim().length === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "A preference key is required.", [
      { path: "key", message: "key must be a non-empty string" },
    ]);
  }
  if (!("value" in body) || body.value === undefined) {
    throw new ApiError(400, "VALIDATION_ERROR", "A preference value is required.", [
      { path: "value", message: "value must be valid JSON" },
    ]);
  }
  const key = body.key.trim();
  const value = body.value;

  const existing = await loadPreferences(supabase, ctx.auth.companyId, key);
  const now = new Date().toISOString();
  if (existing.length > 0) {
    const { error } = await supabase
      .from("person_preferences")
      .update({ value, source: "stated", updated_at: now })
      .eq("company_id", ctx.auth.companyId)
      .eq("subject_type", "owner")
      .is("driver_id", null)
      .is("deleted_at", null)
      .eq("key", key);
    if (error) {
      throw new ApiError(500, "PREFERENCES_UNAVAILABLE", "Your preference could not be saved.");
    }
  } else {
    const { error } = await supabase.from("person_preferences").insert({
      company_id: ctx.auth.companyId,
      subject_type: "owner",
      driver_id: null,
      key,
      value,
      source: "stated",
    });
    if (error) {
      throw new ApiError(500, "PREFERENCES_UNAVAILABLE", "Your preference could not be saved.");
    }
  }
  return NextResponse.json({ key, value });
});
