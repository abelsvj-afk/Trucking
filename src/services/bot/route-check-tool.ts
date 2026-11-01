// Route check as an agent tool (design §13). The Smart Path engine
// (services/smart-path/route-check.ts — the same computation behind
// POST /api/v1/smart-path/route-check and the Smart Path page)
// becomes callable from chat, so a forwarded load can be planned in
// the conversation: he forwards the load, the load gets recorded,
// Abel runs the check and reports the verdict in plain words.
//
// The engine is LOAD-based by design (§8.3): origin, destination,
// truck profile, and the current duty clocks all come from his real
// records — the load on file, its truck, and his duty logs — never
// from free-typed parameters the model could invent. So the tool's
// inputs are the engine's own contract (load_id + departure +
// appointment windows + food mode), Zod-validated exactly like the
// endpoint's schema, and every figure in the result text is copied
// from the engine's response: the loop's grounding guard holds the
// reply to numbers that appear here.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import { timeWindowSchema, type RouteCheckRequest } from "@/data/schemas/smart-path";
import {
  runRouteCheck,
  type RouteCheckProviders,
} from "@/services/smart-path/route-check";
import type { RouteCheckResponse } from "@/types/smart-path";
import type { BotBrainStore } from "./store";

const isoTimestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "must be an ISO timestamp.");

export const routeCheckToolArgs = z.object({
  load_id: z.string().uuid("load_id must be a load id."),
  depart_at: isoTimestamp.optional(),
  pickup_window: timeWindowSchema.optional(),
  delivery_window: timeWindowSchema.optional(),
  food_mode: z.enum(["grocery", "fast_food"]).optional(),
  gallons_to_buy: z
    .number()
    .positive("gallons_to_buy must be positive.")
    .max(300, "gallons_to_buy is larger than any truck tank.")
    .optional(),
});

export type RouteCheckToolInput = z.infer<typeof routeCheckToolArgs>;

const STATUS_HEADLINES: Record<RouteCheckResponse["verdict"]["status"], string> = {
  on_time: "ON TIME",
  early: "EARLY",
  late: "LATE",
  not_legal: "NOT LEGAL",
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function duration(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`;
}

/**
 * The engine's response as grounding text: verdict first, then the
 * engine's own legal/rested/paid/tradeoff lines verbatim, the plan
 * it inserted (breaks, rests, arrival), fuel/food notes it computed,
 * and its warnings verbatim. No figure is derived here — this only
 * formats what the engine returned.
 */
export function formatRouteCheck(result: RouteCheckResponse): string {
  const lines: string[] = [
    `Route check — ${result.load.origin} → ${result.load.destination} (load ${result.load.status}):`,
    `Verdict: ${STATUS_HEADLINES[result.verdict.status]}`,
    `Route: ${result.route.distanceMiles} miles via ${result.route.provider} (truck-checked route: ${result.route.truckLegal ? "yes" : "no"}). Provider drive estimate ${duration(result.route.providerDurationMinutes)}; the plan drives ${duration(result.verdict.assumedDriveMinutes)} — ${result.verdict.driveTimeBasis}`,
  ];

  const sections: [string, string[]][] = [
    ["Legal", result.verdict.legalLines],
    ["Rested", result.verdict.restedLines],
    ["Paid", result.verdict.paidLines],
    ["Tradeoffs", result.verdict.tradeoffLines],
  ];
  for (const [label, section] of sections) {
    for (const line of section) lines.push(`${label}: ${line}`);
  }

  if (result.verdict.makeItDepartureAt) {
    lines.push(`Leave by ${result.verdict.makeItDepartureAt} to arrive by the close of the delivery window, with the same rest plan.`);
  }

  if (result.plan) {
    lines.push(
      `Plan: arrival ${result.plan.arrivalAt ?? "not plannable"}, ${duration(result.plan.totalElapsedMinutes)} total elapsed, ${result.plan.breaks.length} break(s) and ${result.plan.rests.length} rest(s) inserted.`,
    );
    for (const rest of result.plan.rests) {
      lines.push(`Rest near mile ${rest.distanceMilesFromOrigin}: ${rest.startAt} → ${rest.endAt}.`);
    }
  } else {
    lines.push("Plan: no legal plan exists for this departure — see the legal lines above.");
  }

  if (result.fuel.candidates.length > 0) {
    lines.push(`Fuel (ranked by effective cost for ${result.fuel.assumptions.gallonsToBuy} gal):`);
    for (const candidate of result.fuel.candidates.slice(0, 3)) {
      lines.push(
        `- ${candidate.name}: ${candidate.pricePerGallonCents != null ? `${dollars(candidate.pricePerGallonCents)}/gal` : "price unknown"}` +
          `${candidate.effectiveCostCents != null ? `, effective ${dollars(candidate.effectiveCostCents)}` : ""}` +
          `${candidate.detourMiles > 0 ? `, ${candidate.detourMiles} mi detour` : ", on route"} (${candidate.source}).`,
      );
    }
  } else if (result.fuel.unavailableReason) {
    lines.push(`Fuel: no ranked stops — ${result.fuel.unavailableReason}`);
  }

  for (const line of result.food.lines) lines.push(`Food: ${line}`);
  if (result.food.suppressedByFast.length > 0) {
    lines.push(`Food: inside the 8pm–8am fast window, suppressed: ${result.food.suppressedByFast.join(", ")}.`);
  }

  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);

  return lines.join("\n");
}

export interface RouteCheckToolDeps {
  /** Injectable for tests; defaults to the real Smart Path engine. */
  runCheck?: typeof runRouteCheck;
  providers?: RouteCheckProviders;
  now?: () => Date;
}

export function buildRouteCheckTool(store: BotBrainStore, deps: RouteCheckToolDeps = {}): AgentTool {
  const runCheck = deps.runCheck ?? runRouteCheck;
  const now = deps.now ?? (() => new Date());

  return {
    name: "check_route",
    description:
      "Run the Smart Path route check on a RECORDED load (load_id from list_loads) — the same engine as the Smart Path page. It lays the load's route against his live duty clocks (paper-log helper), his truck profile, and the appointment windows, and returns one verdict — ON TIME / EARLY / LATE / NOT LEGAL — with the leave-by time, the breaks/rests it inserts, which routing engine served (and whether it was truck-checked), and fuel/food notes. Origin, destination, truck, and clocks come from his records, never from parameters: if a forwarded load isn't recorded yet, record it first (or stage the dump and tell him the check runs once it's saved), then call this. Use whenever he asks 'can I make this load', 'when do I need to leave', or forwards a load and wants it planned.",
    parameters: {
      type: "object",
      properties: {
        load_id: { type: "string", description: "The recorded load's id (uuid), from list_loads." },
        depart_at: { type: "string", description: "ISO timestamp he plans to leave. Defaults to now." },
        pickup_window: {
          type: "object",
          description: "Pickup appointment window, if the load carries one.",
          properties: { start: { type: "string" }, end: { type: "string" } },
          required: ["start", "end"],
        },
        delivery_window: {
          type: "object",
          description: "Delivery appointment window — the verdict (on time/early/late) is judged against this.",
          properties: { start: { type: "string" }, end: { type: "string" } },
          required: ["start", "end"],
        },
        food_mode: { type: "string", enum: ["grocery", "fast_food"], description: "Default grocery." },
        gallons_to_buy: { type: "number", description: "Gallons the fuel ranking should price. Defaults from the truck's tank." },
      },
      required: ["load_id"],
    },
    access: "read",
    async run(args) {
      const parsed = routeCheckToolArgs.parse(args);
      const request: RouteCheckRequest = {
        load_id: parsed.load_id,
        depart_at: parsed.depart_at ?? now().toISOString(),
        food_mode: parsed.food_mode ?? "grocery",
        ...(parsed.pickup_window ? { pickup_window: parsed.pickup_window } : {}),
        ...(parsed.delivery_window ? { delivery_window: parsed.delivery_window } : {}),
        ...(parsed.gallons_to_buy != null ? { gallons_to_buy: parsed.gallons_to_buy } : {}),
      };
      // Scoped to his company in code (the engine's companyId
      // parameter): on the Telegram surface the client is
      // service-role, where RLS alone would not scope these reads.
      const result = await runCheck(store.client, request, deps.providers, now(), store.companyId);
      return formatRouteCheck(result);
    },
  };
}
