// Gaming System bot tools (docs/design/gaming-system.md §§1.3/6.3).
// The conversational surface of the Game Plan: read the plan freely;
// set/edit the target and promote a what-if ONLY as his direct
// commands (design §1.3 - his own settings execute immediately, like
// every settings write); what-ifs are games against overrides that
// never touch his real data and never auto-promote (§7 item 4).
// All math is the deterministic engine's - these tools format what
// services/game computed, they never compute plan numbers themselves.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { AiProvider } from "@/services/ai/provider";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { GAME_METRIC_LABELS } from "@/lib/game-plan";
import { formatDollars } from "@/lib/truck-fund";
import {
  loadActiveTarget,
  promoteWhatIf,
  runGamePlan,
  type GameRunOutcome,
} from "@/services/game/run-game-plan";
import type { BotBrainStore } from "./store";
import { validateWith } from "./tool-helpers";
import type { GamePlan, GameTarget } from "@/types/entities";

function dollars(cents: number): string {
  return formatDollars(cents);
}

function narrationProvider(): AiProvider {
  try {
    return new OpenAiProvider();
  } catch {
    // No key configured: governance outcomes (capability off, cap)
    // still resolve inside runGamePlan before narration is needed;
    // a run that does need narration fails loud with this message.
    return {
      complete: async () => {
        throw new Error("OPENAI_API_KEY is not configured.");
      },
    };
  }
}

function outcomeText(outcome: GameRunOutcome, metric: GameTarget["metric"]): string {
  switch (outcome.status) {
    case "no_target":
      return "No active game target is set yet.";
    case "skipped_disabled":
      return "The target is saved, but the Game Plan capability is OFF in Settings (More -> Account & settings), so no plan was gamed. Turn it on and ask me to re-game.";
    case "skipped_cap":
      return "The target is saved, but today's re-game cap (4) is used up - the plan re-games tomorrow or at the next checkpoint.";
    case "failure":
      return `The re-game failed: ${outcome.detail} The previous plan still stands.`;
    case "invalid_replaced":
      return `The first game broke his Finance rules and was refused (stored as invalid). The nearest valid plan is now current: ${planSummary(outcome.plan, metric)}`;
    case "success":
      return planSummary(outcome.plan, metric);
  }
}

function planSummary(plan: GamePlan, metric: GameTarget["metric"]): string {
  const out = plan.scenarios;
  const rec = out.scenarios.recommended;
  const lines = [
    `Game Plan v${plan.version} (${plan.status}) - ${GAME_METRIC_LABELS[metric]} target ${dollars(out.gap.targetCents)} by ${out.gap.targetMonth}.`,
    `At your current pace (projection): ${dollars(out.gap.currentPaceCents)}. Conservative path: ${dollars(out.gap.conservativeCents)}. Mixed path: ${dollars(out.gap.mixedCents)}${out.mixedDeclinedByPosture ? " (shown for information - your posture declines side income right now)" : ""}. Recommended path: ${dollars(out.gap.recommendedCents)} - short by ${dollars(rec.shortfallCents)}.`,
  ];
  if (rec.milestones.truckWindowMonth) {
    lines.push(`Truck window: ${rec.milestones.truckWindowMonth} (projection). Authority filing: ${rec.milestones.authorityMonth ?? "not in horizon"}.`);
  }
  if (rec.milestones.authorityReason) lines.push(rec.milestones.authorityReason);
  if (plan.data_sufficiency.thinData) {
    lines.push(
      `THIN DATA: this plan is built on ${plan.data_sufficiency.completedLoads} settled loads / ${plan.data_sufficiency.weeksOfHistory} weeks of records - treat it as a sketch until more history lands.`,
    );
  }
  if (plan.diff_summary) lines.push(plan.diff_summary);
  return lines.join("\n");
}

const setTargetArgs = z.object({
  metric: z.enum(["monthly_net_cents", "truck_fund_cents", "business_value_cents", "net_worth_cents"]),
  target_value_dollars: z.number().positive(),
  target_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  posture: z.enum(["conservative", "mixed"]),
  posture_mix_pct: z.number().int().min(0).max(100).optional(),
  notes: z.string().min(1).optional(),
});

const whatIfArgs = z.object({
  fuel_price_dollars_gal: z.number().min(0).optional(),
  sweep_pct: z.number().min(0).max(100).optional(),
  truck_price_dollars: z.number().positive().optional(),
  truck_financing_dollars: z.number().min(0).optional(),
  insurance_annual_dollars: z.number().min(0).optional(),
  authority_activation_month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullable()
    .optional(),
});

const assumptionArgs = z.object({
  key: z.enum([
    "fuel_price_cents_gal",
    "sweep_pct",
    "truck_price_cents",
    "repair_reserve_cents",
    "authority_startup_cents",
    "insurance_annual_cents",
    "factoring_pct",
    "truck_financing_cents",
    "authority_activation_month",
    "materiality_pct",
    "side_income_levers",
  ]),
  value: z.unknown(),
});

export function buildGameTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;

  return [
    {
      name: "get_game_plan",
      description:
        "His active game target and current Game Plan: the gap at the target date on all three paths (current pace / conservative / mixed - all projections), truck + authority windows, thin-data stamp, and the latest checkpoint verdict. Use for 'how's my plan', 'am I on track', 'when can I buy the truck' questions - the numbers come from the stored plan, never recompute them yourself.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const target = await loadActiveTarget(client, companyId);
        if (!target) return "No game target is set yet. He can set one here ('set my target: ...') or in More -> Game Plan.";
        const { data, error } = await client
          .from("game_plans")
          .select("*")
          .eq("company_id", companyId)
          .eq("target_id", target.id)
          .eq("status", "current")
          .is("deleted_at", null)
          .order("version", { ascending: false })
          .limit(1);
        if (error) throw new Error(error.message);
        const plan = ((data ?? []) as GamePlan[])[0];
        const header = `Target: ${GAME_METRIC_LABELS[target.metric]} ${dollars(target.target_value_cents)}${target.target_date ? ` by ${target.target_date}` : " (open-ended)"} - posture ${target.posture}${target.posture === "mixed" ? ` (${target.posture_mix_pct}% mix)` : ""}.${target.notes ? ` His words: "${target.notes}"` : ""}`;
        if (!plan) return `${header}\nNo plan has been gamed yet (the Game Plan capability may be off, or today's cap is used).`;
        const { data: checkpointRows } = await client
          .from("game_checkpoints")
          .select("period_month, verdict, gap_cents")
          .eq("company_id", companyId)
          .eq("target_id", target.id)
          .is("deleted_at", null)
          .order("period_month", { ascending: false })
          .limit(1);
        const checkpoint = ((checkpointRows ?? []) as { period_month: string; verdict: string | null; gap_cents: number | null }[])[0];
        const checkpointLine = checkpoint
          ? `\nLatest checkpoint (${checkpoint.period_month.slice(0, 7)}): ${checkpoint.verdict ?? "open"}${checkpoint.gap_cents != null ? `, gap ${dollars(checkpoint.gap_cents)}` : ""}.`
          : "";
        return `${header}\n${planSummary(plan, target.metric)}${checkpointLine}\n\n${plan.narration}`;
      },
    },
    {
      name: "set_game_target",
      description:
        "Set his game target (his OWN settings - a direct command from him executes immediately, design §1.3; a target YOU propose still waits for his yes under the standing rule). Deactivates the previous target (kept as history) and re-games the plan. Metric guidance: monthly_net_cents is the one his data feeds today; net_worth_cents renders partial (business-only) until accounts connect - tell him that if he picks it.",
      parameters: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: ["monthly_net_cents", "truck_fund_cents", "business_value_cents", "net_worth_cents"],
          },
          target_value_dollars: { type: "number", description: "The target number, in dollars." },
          target_date: { type: "string", description: "YYYY-MM-DD, or omit for open-ended." },
          posture: { type: "string", enum: ["conservative", "mixed"] },
          posture_mix_pct: { type: "number", description: "0-100 slider: how much of the gap side income may carry. Default 0 conservative / 50 mixed." },
          notes: { type: "string", description: "What the target means to him, in his words." },
        },
        required: ["metric", "target_value_dollars", "posture"],
      },
      access: "write",
      validateArgs: validateWith(setTargetArgs),
      summarize(args) {
        const parsed = setTargetArgs.parse(args);
        return `Game target: ${GAME_METRIC_LABELS[parsed.metric]} ${dollars(Math.round(parsed.target_value_dollars * 100))}${parsed.target_date ? ` by ${parsed.target_date}` : " (open-ended)"}, posture ${parsed.posture}`;
      },
      async run(args) {
        const parsed = setTargetArgs.parse(args);
        const { error: deactivateError } = await client
          .from("game_targets")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("company_id", companyId)
          .eq("is_active", true)
          .is("deleted_at", null);
        if (deactivateError) throw new Error(deactivateError.message);
        const { error } = await client.from("game_targets").insert({
          company_id: companyId,
          metric: parsed.metric,
          target_value_cents: Math.round(parsed.target_value_dollars * 100),
          target_date: parsed.target_date ?? null,
          posture: parsed.posture,
          posture_mix_pct: parsed.posture_mix_pct ?? (parsed.posture === "mixed" ? 50 : 0),
          notes: parsed.notes ?? null,
          is_active: true,
        });
        if (error) throw new Error(error.message);
        const outcome = await runGamePlan({
          client,
          companyId,
          provider: narrationProvider(),
          trigger: "target_set",
          targetChanged: true,
        });
        return `Target set. ${outcomeText(outcome, parsed.metric)}`;
      },
    },
    {
      name: "game_what_if",
      description:
        "Game a what-if: assumption overrides (fuel price, sweep %, truck price, financing, insurance, authority month) run through the SAME engine and stored as a what-if version. It never touches his real data and never replaces the plan - only his explicit 'make that the plan' promotes one (promote_game_plan). A what-if that breaks a Finance rule comes back with the broken rule named. Side-income levers are NOT set here - they need a recorded citation and go through save_game_assumption with the briefing/memory id.",
      parameters: {
        type: "object",
        properties: {
          fuel_price_dollars_gal: { type: "number" },
          sweep_pct: { type: "number" },
          truck_price_dollars: { type: "number" },
          truck_financing_dollars: { type: "number" },
          insurance_annual_dollars: { type: "number" },
          authority_activation_month: { type: "string", description: "YYYY-MM." },
        },
      },
      access: "write",
      validateArgs: validateWith(whatIfArgs),
      summarize(args) {
        return `What-if game: ${JSON.stringify(args)}`;
      },
      async run(args) {
        const parsed = whatIfArgs.parse(args);
        const target = await loadActiveTarget(client, companyId);
        const overrides: Record<string, unknown> = {};
        if (parsed.fuel_price_dollars_gal != null) overrides.fuel_price_cents_gal = Math.round(parsed.fuel_price_dollars_gal * 100);
        if (parsed.sweep_pct != null) overrides.sweep_pct = parsed.sweep_pct;
        if (parsed.truck_price_dollars != null) overrides.truck_price_cents = Math.round(parsed.truck_price_dollars * 100);
        if (parsed.truck_financing_dollars != null) overrides.truck_financing_cents = Math.round(parsed.truck_financing_dollars * 100);
        if (parsed.insurance_annual_dollars != null) overrides.insurance_annual_cents = Math.round(parsed.insurance_annual_dollars * 100);
        if (parsed.authority_activation_month !== undefined) overrides.authority_activation_month = parsed.authority_activation_month;
        const outcome = await runGamePlan({
          client,
          companyId,
          provider: narrationProvider(),
          trigger: "what_if",
          oneOffOverrides: overrides,
        });
        if (outcome.status === "success" && target) {
          const violations = outcome.plan.scenarios.validity.violations;
          const violationText =
            violations.length > 0
              ? `\nThis what-if breaks his Finance rules: ${violations.map((v) => v.detail).join(" ")} It is stored as a labeled what-if only.`
              : "";
          return `What-if gamed (plan v${outcome.plan.version}, NOT the plan - say "make that the plan" to adopt it):\n${planSummary(outcome.plan, target.metric)}${violationText}\n\n${outcome.plan.narration}`;
        }
        return outcomeText(outcome, target?.metric ?? "monthly_net_cents");
      },
    },
    {
      name: "promote_game_plan",
      description:
        "Make a what-if version THE plan - only on his explicit words ('make that the plan'). Takes the plan version number of a what-if for the active target. Nothing is recomputed; the what-if's frozen game becomes current and the old current plan is superseded (kept in history).",
      parameters: {
        type: "object",
        properties: { version: { type: "number", description: "The what-if's plan version number." } },
        required: ["version"],
      },
      access: "write",
      summarize(args) {
        return `Promote what-if plan v${args.version} to the current Game Plan`;
      },
      async run(args) {
        const version = typeof args.version === "number" ? args.version : Number.NaN;
        const target = await loadActiveTarget(client, companyId);
        if (!target) return "No active game target - there is nothing to promote into.";
        const { data, error } = await client
          .from("game_plans")
          .select("id, status")
          .eq("company_id", companyId)
          .eq("target_id", target.id)
          .eq("version", version)
          .is("deleted_at", null)
          .maybeSingle();
        if (error) throw new Error(error.message);
        const row = data as { id: string; status: string } | null;
        if (!row) return `No plan version ${version} exists for the active target.`;
        if (row.status !== "what_if") return `Plan v${version} is a ${row.status} version - only a what-if can be promoted.`;
        const plan = await promoteWhatIf(client, companyId, row.id);
        return `Done - what-if v${plan.version} is now the current Game Plan.`;
      },
    },
    {
      name: "save_game_assumption",
      description:
        "Store a PERSISTENT game assumption override ('always game fuel at $6.50 until I say otherwise') - design §2.5. It applies to every future re-game until he clears it (clear_game_assumption). For side_income_levers the value is the full lever list; every lever MUST cite its source: sourceType 'briefing' with a research_briefings id, or 'memory' with the id of one of his recorded-skill memories - get ids from get_game_plan's candidate list (search_memories / the Game Plan tab). A lever without a real citation is dropped by the engine, in code.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { description: "The override value (number, 'YYYY-MM' string, or the side_income_levers array)." },
        },
        required: ["key", "value"],
      },
      access: "write",
      validateArgs: validateWith(assumptionArgs),
      summarize(args) {
        const parsed = assumptionArgs.parse(args);
        return `Standing game assumption: ${parsed.key} = ${JSON.stringify(parsed.value)}`;
      },
      async run(args) {
        const parsed = assumptionArgs.parse(args);
        await store.saveMemory(
          "game_assumption",
          JSON.stringify({ key: parsed.key, value: parsed.value }),
        );
        return `Saved as a standing assumption - every future re-game uses it until you clear it. It takes effect on the next re-game (ask me to re-game, or it lands at the next trigger).`;
      },
    },
    {
      name: "clear_game_assumption",
      description: "Remove a standing game assumption override by key (see save_game_assumption). Future re-games stop using it.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
      access: "write",
      summarize(args) {
        return `Clear standing game assumption: ${String(args.key)}`;
      },
      async run(args) {
        const key = String(args.key ?? "");
        const { data, error } = await client
          .from("bot_memories")
          .select("id, content")
          .eq("company_id", companyId)
          .eq("kind", "game_assumption")
          .is("deleted_at", null);
        if (error) throw new Error(error.message);
        const rows = ((data ?? []) as { id: string; content: string }[]).filter((row) => {
          try {
            return (JSON.parse(row.content) as { key?: unknown }).key === key;
          } catch {
            return false;
          }
        });
        if (rows.length === 0) return `No standing assumption named ${key} to clear.`;
        const { error: deleteError } = await client
          .from("bot_memories")
          .update({ deleted_at: new Date().toISOString() })
          .in("id", rows.map((r) => r.id))
          .eq("company_id", companyId);
        if (deleteError) throw new Error(deleteError.message);
        return `Cleared the standing assumption ${key}. It stops applying at the next re-game.`;
      },
    },
  ];
}
