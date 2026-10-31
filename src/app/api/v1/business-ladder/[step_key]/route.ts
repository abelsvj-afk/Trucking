// One ladder step's state upsert (docs/design/driver-mvp.md §9.4).
// Steps exist as knowledge before they exist as rows: the first
// state change creates the row. A step_key outside the vision's
// six-rung ladder is a 404, not a new rung - the order is the point.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { createCrudService } from "@/services/db/crud";
import { buildLadderView, isLadderStepKey } from "@/lib/truck-fund";
import { updateLadderStepSchema } from "@/data/schemas/business-ladder";
import type { BusinessLadderStep } from "@/types/entities";
import type { LadderStepView } from "@/types/truck-fund";

const steps = createCrudService<BusinessLadderStep>("business_ladder_steps");

export const PATCH = createApiHandler(async (req, ctx) => {
  const stepKey = ctx.params.step_key;
  if (!stepKey || !isLadderStepKey(stepKey)) throw notFound();

  const body = await validateBody(req, updateLadderStepSchema);
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("business_ladder_steps")
    .select("*")
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as BusinessLadderStep[];
  const existing = rows.find((row) => row.step_key === stepKey);

  const saved = existing
    ? await steps.update(supabase, existing.id, { ...body })
    : await steps.create(supabase, ctx.auth.companyId, { ...body, step_key: stepKey });
  if (!saved) throw notFound();

  const allRows = existing ? rows.map((row) => (row.id === saved.id ? saved : row)) : [...rows, saved];
  const view = buildLadderView(allRows).find((step) => step.stepKey === stepKey)!;
  const response: LadderStepView = {
    step_key: view.stepKey,
    title: view.title,
    what_it_is: view.whatItIs,
    next_action: view.nextAction,
    state: view.state,
    note: view.note,
    unlocked: view.unlocked,
    out_of_order: view.outOfOrder,
  };
  return NextResponse.json(response);
});
