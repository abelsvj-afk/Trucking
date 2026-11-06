// GET/POST /api/v1/device-tokens - issue and list the tokens the native background-tracking shell
// uses (migration 00073). Session-authenticated and tenant-scoped by RLS. The secret is returned
// ONCE, by POST; only its hash is stored, so it can never be shown again - a lost token is revoked
// and replaced. A token can do exactly one thing: post position fixes to /api/v1/position/feed.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { newDeviceToken } from "@/lib/device-token";

const createSchema = z.object({ label: z.string().trim().min(1, "Give the device a name.").max(60) });
const MAX_ACTIVE = 10;

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("device_tokens")
    .select("id, label, created_at, last_used_at")
    .eq("company_id", ctx.auth.companyId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return NextResponse.json({ data: data ?? [] });
});

export const POST = createApiHandler(async (req: NextRequest, ctx) => {
  const { label } = await validateBody(req, createSchema);
  const supabase = await createClient();
  const { count } = await supabase
    .from("device_tokens")
    .select("id", { count: "exact", head: true })
    .eq("company_id", ctx.auth.companyId)
    .is("revoked_at", null);
  if ((count ?? 0) >= MAX_ACTIVE) {
    return NextResponse.json({ error: { code: "UNPROCESSABLE_ENTITY", message: `You already have ${MAX_ACTIVE} active devices. Revoke one first.` } }, { status: 422 });
  }
  const { token, hash } = newDeviceToken();
  const { data, error } = await supabase
    .from("device_tokens")
    .insert({ company_id: ctx.auth.companyId, label, token_hash: hash })
    .select("id, label, created_at")
    .single();
  if (error) throw new Error(error.message);
  // The only time the secret leaves the server.
  return NextResponse.json({ data: { ...(data as object), token } }, { status: 201, headers: { "Cache-Control": "no-store" } });
});
