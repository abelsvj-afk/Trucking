// Game Plan aggregate (docs/design/gaming-system.md §6.3) - the
// Game Plan tab's one fetch: capability state, the active target,
// the current plan, the full version history, the checkpoint
// scoreboard, and the §3.4 side-income candidate sources (briefings
// and his recorded skills a lever may cite). Computed/read-only
// like /truck-fund; all math already happened in lib/game-plan.ts
// at generation time and is frozen on the plan rows.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { MAX_RE_GAMES_PER_DAY } from "@/lib/game-plan";
import {
  countReGamesToday,
  isGamePlanEnabled,
  loadActiveTarget,
} from "@/services/game/run-game-plan";
import { buildGameSnapshot } from "@/services/game/snapshot";
import type { GameCheckpoint, GamePlan } from "@/types/entities";
import type { GamePlanPageData } from "@/types/game-plan";

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const companyId = ctx.auth.companyId;

  const capabilityEnabled = await isGamePlanEnabled(supabase, companyId);
  const target = await loadActiveTarget(supabase, companyId);

  let versions: GamePlan[] = [];
  let checkpoints: GameCheckpoint[] = [];
  if (target) {
    const [plansResult, checkpointsResult] = await Promise.all([
      supabase
        .from("game_plans")
        .select("*")
        .eq("company_id", companyId)
        .eq("target_id", target.id)
        .is("deleted_at", null)
        .order("version", { ascending: false })
        .limit(50),
      supabase
        .from("game_checkpoints")
        .select("*")
        .eq("company_id", companyId)
        .eq("target_id", target.id)
        .is("deleted_at", null)
        .order("period_month", { ascending: false })
        .limit(24),
    ]);
    if (plansResult.error) throw new Error(plansResult.error.message);
    if (checkpointsResult.error) throw new Error(checkpointsResult.error.message);
    versions = (plansResult.data ?? []) as GamePlan[];
    checkpoints = (checkpointsResult.data ?? []) as GameCheckpoint[];
  }

  // Candidate side-income sources are live data (briefings land,
  // memories accumulate) - read them fresh from the snapshot builder
  // rather than from a frozen plan.
  const snapshot = await buildGameSnapshot(supabase, companyId);

  const pageData: GamePlanPageData = {
    capability_enabled: capabilityEnabled,
    target,
    current_plan: versions.find((p) => p.status === "current") ?? null,
    versions,
    checkpoints,
    side_income_candidates: snapshot.sideIncomeCandidates,
    usage: {
      re_games_today: await countReGamesToday(supabase, companyId),
      max_re_games_per_day: MAX_RE_GAMES_PER_DAY,
    },
  };
  return NextResponse.json(pageData);
});
