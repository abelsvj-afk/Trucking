// Shape of the computed GET /api/v1/game-plan aggregate
// (docs/api-contracts.md). Not a stored row, so it lives outside
// entities.ts - same reasoning as financial-summary.ts/truck-fund.ts.

import type { SideIncomeCandidate } from "@/lib/game-plan";
import type { GameCheckpoint, GamePlan, GameTarget } from "./entities";

export interface GamePlanPageData {
  capability_enabled: boolean;
  target: GameTarget | null;
  current_plan: GamePlan | null;
  versions: GamePlan[]; // newest first, all statuses
  checkpoints: GameCheckpoint[]; // newest month first
  side_income_candidates: SideIncomeCandidate[];
  usage: { re_games_today: number; max_re_games_per_day: number };
}
