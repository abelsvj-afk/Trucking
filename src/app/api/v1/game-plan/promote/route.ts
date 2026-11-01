// "Make that the plan" (docs/design/gaming-system.md §§2.3/7) -
// the ONLY promotion path for a what-if, on the owner's explicit
// call. The what-if's frozen snapshot and assumptions become the
// current plan as-is; nothing is recomputed and nothing else about
// his data changes.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { promoteRequestSchema } from "@/data/schemas/game";
import { promoteWhatIf } from "@/services/game/run-game-plan";

export const POST = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, promoteRequestSchema);
  try {
    const plan = await promoteWhatIf(supabase, ctx.auth.companyId, body.plan_id);
    return NextResponse.json({ plan });
  } catch (err) {
    throw validationError(err instanceof Error ? err.message : "Could not promote that what-if.");
  }
});
