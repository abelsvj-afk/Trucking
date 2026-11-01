// One game target (docs/design/gaming-system.md §1.3). Edits to
// metric / value / date / posture are re-game triggers - the plan
// is recomputed against the live target in the same request, and
// the outcome is reported back rather than swallowed.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { updateGameTargetSchema } from "@/data/schemas/game";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { runGamePlan } from "@/services/game/run-game-plan";
import type { GameTarget } from "@/types/entities";

async function loadTarget(companyId: string, id: string): Promise<GameTarget | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("game_targets")
    .select("*")
    .eq("id", id)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as GameTarget | null) ?? null;
}

export const GET = createApiHandler(async (_req, ctx) => {
  const target = await loadTarget(ctx.auth.companyId, ctx.params.id!);
  if (!target) throw notFound();
  return NextResponse.json(target);
});

export const PATCH = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, updateGameTargetSchema);
  const existing = await loadTarget(ctx.auth.companyId, ctx.params.id!);
  if (!existing) throw notFound();

  const { data, error } = await supabase
    .from("game_targets")
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq("id", existing.id)
    .eq("company_id", ctx.auth.companyId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  const target = data as GameTarget;

  // Only the ACTIVE target's edits re-game - editing an old,
  // deactivated target is bookkeeping on history.
  const outcome = target.is_active
    ? await runGamePlan({
        client: supabase,
        companyId: ctx.auth.companyId,
        provider: new OpenAiProvider(),
        trigger: "target_edit",
        targetChanged: true,
      })
    : { status: "not_active" as const };

  return NextResponse.json({ target, game: outcome });
});

export const DELETE = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const existing = await loadTarget(ctx.auth.companyId, ctx.params.id!);
  if (!existing) throw notFound();
  const { error } = await supabase
    .from("game_targets")
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq("id", existing.id)
    .eq("company_id", ctx.auth.companyId);
  if (error) throw new Error(error.message);
  return new NextResponse(null, { status: 204 });
});
