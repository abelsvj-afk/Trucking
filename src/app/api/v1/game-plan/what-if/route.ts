// Conversational what-ifs, in API form (docs/design/gaming-system.md
// §2.3): assumption overrides gamed into a what_if VERSION. A
// what-if never touches real data and never replaces the current
// plan - promotion is the separate explicit call (§7 item 4). A
// what-if that breaks a Finance rule is stored and returned WITH
// its violations named (design §5.5: a financed path renders only
// as a labeled what-if with the rule it breaks named).

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { whatIfRequestSchema } from "@/data/schemas/game";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { runGamePlan } from "@/services/game/run-game-plan";

export const POST = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, whatIfRequestSchema);

  const outcome = await runGamePlan({
    client: supabase,
    companyId: ctx.auth.companyId,
    provider: new OpenAiProvider(),
    trigger: "what_if",
    oneOffOverrides: body.overrides as Record<string, unknown>,
  });

  if (outcome.status === "no_target") {
    return NextResponse.json(
      { error: { code: "no_target", message: "Set a target first - a what-if games against the live target." } },
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
