// GAP-04 (Fresh-Eyes Register 2026-11-02): the load's facility
// clock. GET returns the stamps plus the computed detention summary
// (one computation — src/lib/detention.ts — quoted by the page,
// Abel, and the claim pack). POST stamps the clock: body names the
// stamp; occurred_at defaults to now, correctable later via PATCH
// on the generic stamps route. Tenant isolation is RLS, as
// everywhere; the load lookup doubles as the existence check.

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { createDetentionStampSchema } from "@/data/schemas/detention-stamps";
import { computeDetention } from "@/lib/detention";
import type { DetentionStamp, Load } from "@/types/entities";

async function loadOr404(supabase: Awaited<ReturnType<typeof createClient>>, loadId: string) {
  const { data, error } = await supabase
    .from("loads")
    .select("*")
    .eq("id", loadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw notFound();
  return data as Load;
}

export const GET = createApiHandler(async (_req: NextRequest, { params }) => {
  const supabase = await createClient();
  const load = await loadOr404(supabase, params.id!);
  const { data, error } = await supabase
    .from("detention_stamps")
    .select("*")
    .eq("load_id", load.id)
    .is("deleted_at", null)
    .order("occurred_at", { ascending: true });
  if (error) throw new Error(error.message);
  const stamps = (data ?? []) as DetentionStamp[];
  return NextResponse.json({ data: stamps, summary: computeDetention(load, stamps) });
});

export const POST = createApiHandler(async (req: NextRequest, { auth, params }) => {
  const body = await validateBody(req, createDetentionStampSchema);
  const supabase = await createClient();
  const load = await loadOr404(supabase, params.id!);
  const { data, error } = await supabase
    .from("detention_stamps")
    .insert({
      company_id: auth.companyId,
      load_id: load.id,
      stamp_type: body.stamp_type,
      stop_kind: body.stop_kind ?? "delivery",
      occurred_at: body.occurred_at ?? new Date().toISOString(),
      notes: body.notes ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return NextResponse.json({ data }, { status: 201 });
});
