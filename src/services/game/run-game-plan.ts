// Gaming System runner (docs/design/gaming-system.md §§2/4/5).
// One full re-game: snapshot (real queried actuals) -> assumption
// sheet (every value sourced) -> deterministic engine (code does
// the math) -> STABILIZE validity fence -> narration (the model
// writes prose over the computed numbers, checked for banned
// phrases and ungrounded figures before anything is stored) ->
// a new plan VERSION with a code-computed diff. Never a silent
// overwrite; never a plan the rules forbid.
//
// Governance mirrors the research engine: the game_plan capability
// fails closed, the daily cap is counted from the game_plan_runs
// log (never memory), and every outcome - success, failure,
// skipped_cap, skipped_disabled, invalid_replaced - lands in that
// log rather than disappearing.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildAssumptions,
  dataSufficiency,
  gamePlan,
  makeNearestValid,
  validateScenarios,
  MAINTENANCE_SPIKE_THRESHOLD_CENTS,
  MAX_RE_GAMES_PER_DAY,
  type GameSnapshot,
  type ResolvedAssumptions,
  type TargetLike,
  type ValidityViolation,
} from "@/lib/game-plan";
import {
  allowedFigureSet,
  computePlanDiff,
  findBannedPhrases,
  findUngroundedFigures,
  type StoredPlanShape,
} from "@/lib/game-text";
import { formatDollars } from "@/lib/truck-fund";
import type { AiProvider } from "@/services/ai/provider";
import type { GamePlan, GamePlanTrigger, GameTarget } from "@/types/entities";
import { buildGameSnapshot } from "./snapshot";

export const GAME_PLAN_CAPABILITY = "game_plan";

const COUNTED_STATUSES = ["success", "failure", "invalid_replaced"];

export type GameRunOutcome =
  | { status: "no_target" }
  | { status: "skipped_disabled" }
  | { status: "skipped_cap" }
  | { status: "failure"; detail: string }
  | { status: "success"; plan: GamePlan; material: boolean }
  | { status: "invalid_replaced"; plan: GamePlan; violations: ValidityViolation[] };

/** The game_plan kill switch: global first, then per-capability, no row = off. */
export async function isGamePlanEnabled(client: SupabaseClient, companyId: string): Promise<boolean> {
  const [companyResult, capabilityResult] = await Promise.all([
    client.from("companies").select("ai_globally_disabled").eq("id", companyId).single(),
    client
      .from("ai_capability_settings")
      .select("enabled")
      .eq("company_id", companyId)
      .eq("capability", GAME_PLAN_CAPABILITY)
      .maybeSingle(),
  ]);
  if (companyResult.error) throw new Error(companyResult.error.message);
  if (capabilityResult.error) throw new Error(capabilityResult.error.message);
  const globallyDisabled =
    (companyResult.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled ?? false;
  const capabilityEnabled = (capabilityResult.data as { enabled: boolean } | null)?.enabled ?? false;
  return !globallyDisabled && capabilityEnabled;
}

/** The engine speaks camelCase (TargetLike); the row speaks snake_case. */
export function toTargetLike(target: GameTarget): TargetLike {
  return {
    metric: target.metric,
    targetValueCents: target.target_value_cents,
    targetDate: target.target_date,
    posture: target.posture,
    postureMixPct: target.posture_mix_pct,
  };
}

export async function loadActiveTarget(
  client: SupabaseClient,
  companyId: string,
): Promise<GameTarget | null> {
  const { data, error } = await client
    .from("game_targets")
    .select("*")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as GameTarget | null) ?? null;
}

/**
 * Persistent assumption overrides (design §2.5) live in bot_memories
 * with kind 'game_assumption' - the store already injected into
 * every prompt. Content is one JSON object: {"key": ..., "value": ...}.
 * Unparseable rows are ignored, never fatal.
 */
export async function loadPersistentOverrides(
  client: SupabaseClient,
  companyId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await client
    .from("bot_memories")
    .select("content, created_at")
    .eq("company_id", companyId)
    .eq("kind", "game_assumption")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(error.message);
  const overrides: Record<string, unknown> = {};
  for (const row of (data ?? []) as { content: string }[]) {
    try {
      const parsed = JSON.parse(row.content) as { key?: unknown; value?: unknown };
      if (typeof parsed.key === "string") overrides[parsed.key] = parsed.value;
    } catch {
      // Not a JSON override row - someone dictated a note into the
      // kind; it is not an instruction the engine can use.
    }
  }
  return overrides;
}

async function logRun(
  client: SupabaseClient,
  companyId: string,
  targetId: string | null,
  trigger: GamePlanTrigger,
  status: string,
  planId: string | null,
  detail: string | null,
): Promise<void> {
  const { error } = await client.from("game_plan_runs").insert({
    company_id: companyId,
    target_id: targetId,
    trigger,
    status,
    plan_id: planId,
    detail,
  });
  if (error) throw new Error(error.message);
}

export async function countReGamesToday(client: SupabaseClient, companyId: string): Promise<number> {
  const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const { count, error } = await client
    .from("game_plan_runs")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .in("status", COUNTED_STATUSES)
    .gte("created_at", startOfDay);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function loadCurrentPlan(
  client: SupabaseClient,
  companyId: string,
  targetId: string,
): Promise<GamePlan | null> {
  const { data, error } = await client
    .from("game_plans")
    .select("*")
    .eq("company_id", companyId)
    .eq("target_id", targetId)
    .eq("status", "current")
    .is("deleted_at", null)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? []) as GamePlan[])[0] ?? null;
}

async function nextVersion(client: SupabaseClient, companyId: string, targetId: string): Promise<number> {
  const { data, error } = await client
    .from("game_plans")
    .select("version")
    .eq("company_id", companyId)
    .eq("target_id", targetId)
    .is("deleted_at", null)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const top = ((data ?? []) as { version: number }[])[0];
  return (top?.version ?? 0) + 1;
}

const NARRATION_SYSTEM = [
  "You write the plain-language narration for a trucking owner's game plan - a projection he aims at, never a promise.",
  "Answer with a JSON object with exactly one field: \"narration\" - the plain-language plan text.",
  "Rules, no exceptions:",
  "- Use ONLY the figures in the data you are given. Never invent a number, a date, or a fact.",
  "- Never promise outcomes: the words guaranteed, guarantee, will make, locked in, sure thing, risk-free are banned.",
  "- Call every projected number a projection. Windows are windows ('around May'), not appointments.",
  "- Plain words for a driver reading in a cab. Short paragraphs. No hype.",
  "- Structure: where he stands, what the recommended path does and why this lever order, what the gap honestly is, the demands on him, and the ONE next action.",
].join("\n");

function narrationPrompt(input: {
  target: GameTarget;
  snapshot: GameSnapshot;
  output: ReturnType<typeof gamePlan>;
  removedForValidity: string[];
}): string {
  const { target, snapshot, output } = input;
  const rec = output.scenarios.recommended;
  return JSON.stringify(
    {
      target: {
        metric: target.metric,
        target_value: formatDollars(target.target_value_cents),
        target_date: target.target_date ?? "open-ended",
        posture: target.posture,
        posture_mix_pct: target.posture_mix_pct,
        his_notes: target.notes,
      },
      data_sufficiency: dataSufficiency(snapshot),
      gap_at_target_date: {
        target: formatDollars(output.gap.targetCents),
        current_pace: formatDollars(output.gap.currentPaceCents),
        conservative: formatDollars(output.gap.conservativeCents),
        mixed: formatDollars(output.gap.mixedCents),
        recommended: formatDollars(output.gap.recommendedCents),
        shortfall_on_recommended: formatDollars(rec.shortfallCents),
      },
      milestones: rec.milestones,
      demands: rec.demands,
      levers: output.levers.map((l) => ({
        label: l.label,
        contribution: formatDollars(l.contributionCents),
        source: l.source,
      })),
      removed_for_validity: input.removedForValidity,
      mixed_declined_by_posture: output.mixedDeclinedByPosture,
    },
    null,
    2,
  );
}

/** Generates narration and holds it to the §5 fence; one retry, then fail loud. */
async function narrate(
  provider: AiProvider,
  input: Parameters<typeof narrationPrompt>[0],
  allowed: Set<number>,
): Promise<string> {
  const prompt = narrationPrompt(input);
  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await provider.complete({
      system: NARRATION_SYSTEM,
      user: attempt === 0 ? prompt : `${prompt}\n\nYour previous draft broke the rules: ${lastProblem}. Rewrite it inside the rules.`,
    });
    let text: string;
    try {
      const parsed = JSON.parse(raw) as { narration?: unknown };
      if (typeof parsed.narration !== "string" || parsed.narration.trim() === "") {
        throw new Error("missing narration field");
      }
      text = parsed.narration;
    } catch {
      lastProblem = "it did not answer with a JSON object carrying a narration field";
      continue;
    }
    const banned = findBannedPhrases(text);
    if (banned.length > 0) {
      lastProblem = `it used banned promise language (${banned.join(", ")})`;
      continue;
    }
    const ungrounded = findUngroundedFigures(text, allowed);
    if (ungrounded.length > 0) {
      lastProblem = `it used figures that trace to nothing in the plan (${ungrounded.map(formatDollars).join(", ")})`;
      continue;
    }
    return text.trim();
  }
  throw new Error(`Narration failed the honesty fence twice (${lastProblem}). No plan was stored.`);
}

export interface RunGamePlanInput {
  client: SupabaseClient;
  companyId: string;
  provider: AiProvider;
  trigger: GamePlanTrigger;
  oneOffOverrides?: Record<string, unknown>;
  targetChanged?: boolean;
}

/**
 * The full re-game. For trigger 'what_if' the result is stored as a
 * what-if version and the current plan is untouched - a what-if
 * never auto-promotes (design §7 item 4); promotion is the separate
 * explicit promoteWhatIf() below.
 */
export async function runGamePlan(input: RunGamePlanInput): Promise<GameRunOutcome> {
  const { client, companyId, provider, trigger } = input;
  const isWhatIf = trigger === "what_if";

  const target = await loadActiveTarget(client, companyId);
  if (!target) return { status: "no_target" };

  if (!(await isGamePlanEnabled(client, companyId))) {
    await logRun(client, companyId, target.id, trigger, "skipped_disabled", null,
      "Game Plan capability is off for this company (Settings) - the re-game was not run.");
    return { status: "skipped_disabled" };
  }

  const runsToday = await countReGamesToday(client, companyId);
  if (runsToday >= MAX_RE_GAMES_PER_DAY) {
    await logRun(client, companyId, target.id, trigger, "skipped_cap", null,
      `Daily re-game cap reached (${runsToday}/${MAX_RE_GAMES_PER_DAY}).`);
    return { status: "skipped_cap" };
  }

  try {
    const snapshot = await buildGameSnapshot(client, companyId);
    const persistent = await loadPersistentOverrides(client, companyId);
    const built = buildAssumptions({
      snapshot,
      persistentOverrides: persistent,
      oneOffOverrides: input.oneOffOverrides,
    });

    const engineInput = { snapshot, target: toTargetLike(target), values: built.values };
    let output = gamePlan(engineInput);
    let violations = validateScenarios(engineInput, output);
    const originalViolations = violations;
    let removedForValidity: string[] = [];
    let finalSheet = built.sheet;
    let finalValues: ResolvedAssumptions = built.values;
    let wasInvalid = false;

    if (violations.length > 0 && !isWhatIf) {
      // Store the offending game as invalid_rules first - the record
      // of what was refused is part of the fence (design §5.5).
      wasInvalid = true;
      const invalidVersion = await nextVersion(client, companyId, target.id);
      const { data: invalidRow, error: invalidError } = await client
        .from("game_plans")
        .insert({
          company_id: companyId,
          target_id: target.id,
          version: invalidVersion,
          status: "invalid_rules",
          trigger,
          snapshot,
          assumptions: built.sheet,
          scenarios: { ...output, validity: { valid: false, violations } },
          narration:
            `This game was NOT adopted - it broke your Finance rules: ${violations.map((v) => v.detail).join(" ")} ` +
            "The plan below is the nearest version that plays by the rules.",
          diff_summary: null,
          data_sufficiency: dataSufficiency(snapshot),
        })
        .select("*")
        .single();
      if (invalidError) throw new Error(invalidError.message);
      void invalidRow;

      // The nearest valid plan: offending levers removed from the
      // resolved values, re-gamed. The removals ARE the difference
      // between the refused game and the adopted one.
      const nearest = makeNearestValid(engineInput, violations);
      removedForValidity = nearest.removed;
      finalValues = nearest.values;
      const validInput = { snapshot, target: engineInput.target, values: finalValues };
      output = gamePlan(validInput);
      const remaining = validateScenarios(validInput, output);
      if (remaining.length > 0) {
        await logRun(client, companyId, target.id, trigger, "failure", null,
          `Even the nearest-valid re-game broke rules: ${remaining.map((v) => v.rule).join(", ")}.`);
        return { status: "failure", detail: "No valid plan could be produced from the current numbers." };
      }
      finalSheet = [
        ...built.sheet,
        ...removedForValidity.map((text) => ({
          key: "validity_removal",
          value: text,
          source: "his_override",
          adjustable: false,
        })),
      ];
      violations = [];
    }

    const allowed = allowedFigureSet([snapshot, finalSheet, output]);
    const narration = await narrate(
      provider,
      { target, snapshot, output, removedForValidity },
      allowed,
    );

    const previous = await loadCurrentPlan(client, companyId, target.id);
    const version = await nextVersion(client, companyId, target.id);
    const diff = isWhatIf
      ? null
      : computePlanDiff({
          previous: previous
            ? {
                version: previous.version,
                trigger: previous.trigger,
                assumptions: previous.assumptions,
                scenarios: previous.scenarios,
              }
            : null,
          nextVersion: version,
          next: output,
          nextAssumptions: finalSheet,
          trigger,
          materialityPct: finalValues.materialityPct,
          targetChanged: input.targetChanged ?? false,
        });

    const { data: stored, error: storeError } = await client
      .from("game_plans")
      .insert({
        company_id: companyId,
        target_id: target.id,
        version,
        status: isWhatIf ? "what_if" : "current",
        trigger,
        snapshot,
        assumptions: finalSheet,
        scenarios: {
          ...output,
          validity: { valid: violations.length === 0, violations },
          removedForValidity,
        },
        narration,
        diff_summary: isWhatIf
          ? `What-if (not the plan): gamed with overrides against current plan${previous ? ` v${previous.version}` : ""}. Gap on the recommended path: ${formatDollars(-output.scenarios.recommended.shortfallCents)} (projection).`
          : diff!.text,
        data_sufficiency: dataSufficiency(snapshot),
      })
      .select("*")
      .single();
    if (storeError) throw new Error(storeError.message);
    const plan = stored as GamePlan;

    if (!isWhatIf && previous) {
      const { error: supersedeError } = await client
        .from("game_plans")
        .update({ status: "superseded" })
        .eq("id", previous.id)
        .eq("company_id", companyId);
      if (supersedeError) throw new Error(supersedeError.message);
    }

    await logRun(
      client,
      companyId,
      target.id,
      trigger,
      wasInvalid ? "invalid_replaced" : "success",
      plan.id,
      wasInvalid ? `Replaced an invalid game; removed: ${removedForValidity.join("; ")}` : null,
    );

    return wasInvalid
      ? { status: "invalid_replaced", plan, violations: originalViolations }
      : { status: "success", plan, material: diff?.material ?? true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await logRun(client, companyId, target.id, trigger, "failure", null, detail);
    return { status: "failure", detail };
  }
}

/**
 * "Make that the plan" (design §2.3) - the ONLY way a what-if
 * becomes current, on his explicit word. The what-if's frozen
 * snapshot/assumptions become the plan as-is; nothing is recomputed.
 */
export async function promoteWhatIf(
  client: SupabaseClient,
  companyId: string,
  planId: string,
): Promise<GamePlan> {
  const { data, error } = await client
    .from("game_plans")
    .select("*")
    .eq("id", planId)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const plan = data as GamePlan | null;
  if (!plan) throw new Error("No such plan version.");
  if (plan.status !== "what_if") throw new Error("Only a what-if version can be promoted to the plan.");

  const previous = await loadCurrentPlan(client, companyId, plan.target_id);
  if (previous) {
    const { error: supersedeError } = await client
      .from("game_plans")
      .update({ status: "superseded" })
      .eq("id", previous.id)
      .eq("company_id", companyId);
    if (supersedeError) throw new Error(supersedeError.message);
  }
  const { data: updated, error: updateError } = await client
    .from("game_plans")
    .update({ status: "current" })
    .eq("id", plan.id)
    .eq("company_id", companyId)
    .select("*")
    .single();
  if (updateError) throw new Error(updateError.message);
  return updated as GamePlan;
}

/**
 * Data-trigger evaluation (design §4.1) for the daily tick: compares
 * the world against the last current plan's frozen snapshot and
 * names the trigger that fired, if any. Data triggers re-game at
 * most once per day (the caller checks the run log) - dump intake
 * makes settlements lumpy, and a re-game per row would burn the cap
 * on noise.
 */
export async function evaluateDataTriggers(
  client: SupabaseClient,
  companyId: string,
): Promise<GamePlanTrigger | null> {
  const target = await loadActiveTarget(client, companyId);
  if (!target) return null;
  const current = await loadCurrentPlan(client, companyId, target.id);
  if (!current) return null;

  const sincePlan = current.created_at;

  const { data: maintenance, error: maintenanceError } = await client
    .from("maintenance_events")
    .select("cost_cents")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .gte("created_at", sincePlan)
    .gte("cost_cents", MAINTENANCE_SPIKE_THRESHOLD_CENTS)
    .limit(1);
  if (maintenanceError) throw new Error(maintenanceError.message);
  if ((maintenance ?? []).length > 0) return "maintenance_event";

  const { data: briefings, error: briefingError } = await client
    .from("research_briefings")
    .select("id")
    .eq("company_id", companyId)
    .gte("created_at", sincePlan)
    .limit(1);
  if (briefingError) throw new Error(briefingError.message);
  if ((briefings ?? []).length > 0) return "research_briefing";

  const fresh = await buildGameSnapshot(client, companyId);
  const previous = current.snapshot;
  const bandPct = (balance: number) =>
    previous.fundTargetCents != null && previous.fundTargetCents > 0
      ? Math.floor((balance / (fresh.fundTargetCents ?? previous.fundTargetCents)) * 4)
      : null;
  const prevBand = bandPct(previous.truckFundBalanceCents);
  const nextBand = bandPct(fresh.truckFundBalanceCents);
  if (prevBand != null && nextBand != null && nextBand > prevBand) return "fund_milestone";

  if (fresh.completedLoads > previous.completedLoads) return "settlement";
  return null;
}
