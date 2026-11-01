// Gaming System targets (docs/design/gaming-system.md §1).
// Setting a target is the owner's own settings write - it executes
// immediately, like every settings write (design §1.3) - and it is a
// re-game trigger: the plan he sees is never computed against a
// target he already replaced. Creating a target deactivates the
// previous active one (exactly one active per company; old targets
// are history, never deleted by this flow).

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { createGameTargetSchema } from "@/data/schemas/game";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { runGamePlan } from "@/services/game/run-game-plan";
import type { GameTarget } from "@/types/entities";

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("game_targets")
    .select("*")
    .eq("company_id", ctx.auth.companyId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return NextResponse.json({ data: (data ?? []) as GameTarget[] });
});

export const POST = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, createGameTargetSchema);

  const { error: deactivateError } = await supabase
    .from("game_targets")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("company_id", ctx.auth.companyId)
    .eq("is_active", true)
    .is("deleted_at", null);
  if (deactivateError) throw new Error(deactivateError.message);

  const { data, error } = await supabase
    .from("game_targets")
    .insert({
      company_id: ctx.auth.companyId,
      metric: body.metric,
      target_value_cents: body.target_value_cents,
      target_date: body.target_date ?? null,
      posture: body.posture,
      posture_mix_pct: body.posture_mix_pct ?? (body.posture === "mixed" ? 50 : 0),
      notes: body.notes ?? null,
      is_active: true,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  const target = data as GameTarget;

  // The re-game rides along: its outcome (including the visible
  // skipped_disabled / skipped_cap governance outcomes) is reported
  // in the response, never swallowed.
  const outcome = await runGamePlan({
    client: supabase,
    companyId: ctx.auth.companyId,
    provider: new OpenAiProvider(),
    trigger: "target_set",
    targetChanged: true,
  });

  return NextResponse.json({ target, game: outcome }, { status: 201 });
});
