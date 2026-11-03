// GAP-05 (Fresh-Eyes Register 2026-11-02): the load's paperwork
// state — required vs attached, computed by src/lib/paperwork.ts.
// The load page's closeout warning, Abel's answers, and the
// day-wrap (GAP-08) all read this one endpoint.

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { computePaperwork } from "@/lib/paperwork";
import type { Document, Expense, Load } from "@/types/entities";

export const GET = createApiHandler(async (_req: NextRequest, { params }) => {
  const supabase = await createClient();
  const { data: loadData, error: loadError } = await supabase
    .from("loads")
    .select("*")
    .eq("id", params.id!)
    .is("deleted_at", null)
    .maybeSingle();
  if (loadError) throw new Error(loadError.message);
  if (!loadData) throw notFound();
  const load = loadData as Load;

  const [docsResult, expensesResult] = await Promise.all([
    supabase
      .from("documents")
      .select("id, doc_type")
      .eq("related_entity_type", "load")
      .eq("related_entity_id", load.id),
    supabase
      .from("expenses")
      .select("category, description")
      .eq("load_id", load.id)
      .is("deleted_at", null),
  ]);
  if (docsResult.error) throw new Error(docsResult.error.message);
  if (expensesResult.error) throw new Error(expensesResult.error.message);

  const state = computePaperwork(
    load,
    (docsResult.data ?? []) as Pick<Document, "id" | "doc_type">[],
    (expensesResult.data ?? []) as Pick<Expense, "category" | "description">[],
  );
  return NextResponse.json({ data: state });
});
