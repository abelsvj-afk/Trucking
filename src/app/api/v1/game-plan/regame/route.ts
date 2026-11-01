// Manual re-game (docs/design/gaming-system.md §4.1): the tab's
// "Re-game my plan" button. Runs the full governed pipeline -
// capability, daily cap, validity fence, narration checks - and
// returns the outcome verbatim: governance outcomes
// (skipped_disabled / skipped_cap) are successes of the API with a
// visible status, a narration failure is a 422 with the reason.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { regameRequestSchema } from "@/data/schemas/game";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { runGamePlan } from "@/services/game/run-game-plan";

export const POST = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, regameRequestSchema);

  const outcome = await runGamePlan({
    client: supabase,
    companyId: ctx.auth.companyId,
    provider: new OpenAiProvider(),
    trigger: body.trigger ?? "manual",
  });

  if (outcome.status === "no_target") {
    return NextResponse.json(
      { error: { code: "no_target", message: "Set a target first - there is nothing to game against." } },
      { status: 422 },
    );
  }
  if (outcome.status === "failure") {
    return NextResponse.json(
      { error: { code: "game_failed", message: outcome.detail } },
      { status: 422 },
    );
  }
  return NextResponse.json({ game: outcome });
});
