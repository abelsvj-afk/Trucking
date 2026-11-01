// Business finance ladder (docs/design/driver-mvp.md §9.4, vision
// §8). The step definitions are static knowledge in lib/truck-fund.ts;
// the database holds only owner-set state. This route merges the two
// into the view the UI renders - same merge GET /truck-fund embeds.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { buildLadderView } from "@/lib/truck-fund";
import type { BusinessLadderStep } from "@/types/entities";
import type { LadderStepView } from "@/types/truck-fund";

export const GET = createApiHandler(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("business_ladder_steps")
    .select("*")
    .is("deleted_at", null);
  if (error) throw new Error(error.message);

  const view: LadderStepView[] = buildLadderView((data ?? []) as BusinessLadderStep[]).map(
    (step) => ({
      step_key: step.stepKey,
      title: step.title,
      what_it_is: step.whatItIs,
      next_action: step.nextAction,
      state: step.state,
      note: step.note,
      unlocked: step.unlocked,
      out_of_order: step.outOfOrder,
    }),
  );
  return NextResponse.json(view);
});
