// GET /api/v1/loads/[id]/economics - one load's contribution margin (Unit D, D-02).
// Revenue is the load's rate; costs are ONLY expenses and fuel carrying this load's
// id. RLS scopes everything; the load lookup is the existence check (404 otherwise).

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { computeLoadEconomics } from "@/lib/load-economics";
import type { Load } from "@/types/entities";

export const GET = createApiHandler(async (_req: NextRequest, { params }) => {
  const supabase = await createClient();
  const loadId = params.id!;
  const { data: loadRow, error: loadError } = await supabase
    .from("loads")
    .select("id, rate_cents, status, delivery_date")
    .eq("id", loadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (loadError) throw new Error(loadError.message);
  if (!loadRow) throw notFound();
  const load = loadRow as Pick<Load, "rate_cents" | "status" | "delivery_date">;

  const [expenses, fuel] = await Promise.all([
    supabase.from("expenses").select("amount_cents").eq("load_id", loadId).is("deleted_at", null),
    supabase.from("fuel_purchases").select("total_cost_cents").eq("load_id", loadId).is("deleted_at", null),
  ]);
  if (expenses.error) throw new Error(expenses.error.message);
  if (fuel.error) throw new Error(fuel.error.message);

  const economics = computeLoadEconomics(
    load,
    ((expenses.data ?? []) as { amount_cents: number }[]).map((r) => r.amount_cents),
    ((fuel.data ?? []) as { total_cost_cents: number }[]).map((r) => r.total_cost_cents),
  );
  return NextResponse.json({ data: economics });
});
