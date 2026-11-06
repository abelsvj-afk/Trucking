// DELETE /api/v1/device-tokens/[id] - revoke a device token (migration 00073). Revocation is a
// timestamp, never a delete, so the audit trail stays; the position feed refuses the token at once.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";

export const DELETE = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("device_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", ctx.params.id!)
    .eq("company_id", ctx.auth.companyId)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw notFound();
  return NextResponse.json({ data: { revoked: true } });
});
