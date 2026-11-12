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
import { formatEastern, formatMinutes } from "@/lib/smart-path";
import * as smartPathStops from "@/lib/smart-path-stops";
import type { RankedFuelCandidate } from "@/lib/smart-path-stops";
import type { BotBrainStore } from "./store";
import { formatMoney } from "@/lib/money-format";

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
  // Piece 1 parity (P1-7/P1-9): the deadhead start and the life
  // preferences, mirroring routeCheckRequestSchema exactly — all
  // optional; absence is the pre-Piece-1 behavior.
  start_location: z.string().trim().min(3).max(200).optional(),
  start_point: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .optional(),
  start_at: isoTimestamp.optional(),
  life: z
    .object({
      sleep_start_hour: z.number().int().min(0).max(23).optional(),
      sleep_end_hour: z.number().int().min(0).max(23).optional(),
      workout: z
        .object({
          want: z.boolean(),
          minutes: z.number().int().min(30).max(180).default(60),
          setting: z.enum(["gym_preferred", "any_safe_stop"]).default("gym_preferred"),
        })
        .optional(),
    })
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
  return formatMoney(cents);
}

function duration(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`;
}

// ---------------------------------------------------------------------
// Piece 1 response additions (P1-6/P1-7/P1-9), consumed defensively:
// these fields land on RouteCheckResponse from the parallel lanes, so
// they are read through this widened view — a response without them
// (no start given, no life preferences) formats exactly as before.

export interface RouteCheckDeadhead {
  startLabel: string;
  distanceMiles: number;
  leaveByAt: string;
  pickupArrivalAt: string;
  waitMinutesAtPickup: number;
}

export interface RouteCheckWorkout {
  placed: boolean;
  startAt: string | null;
  durationMinutes: number;
  placeName: string | null;
  placeKind: string | null;
  note: string;
}

type RouteCheckResponseParity = RouteCheckResponse & {
  deadhead?: RouteCheckDeadhead | null;
  verdict: RouteCheckResponse["verdict"] & {
    lifeLines?: string[];
    leaveStartByAt?: string | null;
  };
  plan:
    | (NonNullable<RouteCheckResponse["plan"]> & { workout?: RouteCheckWorkout | null })
    | null;
};

type FuelCandidateParity = RankedFuelCandidate & {
  usedEstimate?: boolean;
  estimatedPricePerGallonCents?: number | null;
  estimateLabel?: string | null;
};

/**
 * The price segment of a fuel line. A candidate ranked on the EIA
 * estimate tier (usedEstimate) is spoken as an estimate, never as a
 * real station price: the stops lib's formatFuelPriceLine (P1-6)
 * renders it when present; the fallback here labels it "est." from
 * the estimate fields. Logged (real) prices keep the tool's existing
 * verbatim rendering.
 */
function fuelPriceText(candidate: FuelCandidateParity): string {
  if (candidate.usedEstimate) {
    const formatFuelPriceLine = (
      smartPathStops as unknown as {
        formatFuelPriceLine?: (c: FuelCandidateParity) => string;
      }
    ).formatFuelPriceLine;
    if (typeof formatFuelPriceLine === "function") {
      const text = formatFuelPriceLine(candidate);
      if (text) return text;
    }
    if (candidate.estimatedPricePerGallonCents != null) {
      return (
        `≈${dollars(candidate.estimatedPricePerGallonCents)}/gal (est.` +
        `${candidate.estimateLabel ? ` — ${candidate.estimateLabel}` : ""})`
      );
    }
    if (candidate.pricePerGallonCents != null) {
      return `${dollars(candidate.pricePerGallonCents)}/gal (est.)`;
    }
    return "price unknown (est. unavailable)";
  }
  return candidate.pricePerGallonCents != null
    ? `${dollars(candidate.pricePerGallonCents)}/gal`
    : "price unknown";
}

/**
 * The engine's response as grounding text: verdict first, then the
 * engine's own legal/rested/paid/tradeoff lines verbatim, the plan
 * it inserted (breaks, rests, arrival), fuel/food notes it computed,
 * and its warnings verbatim. No figure is derived here — this only
 * formats what the engine returned.
 */
export function formatRouteCheck(result: RouteCheckResponse): string {
  const parity = result as RouteCheckResponseParity;
  const lines: string[] = [
    `Route check — ${result.load.origin} → ${result.load.destination} (load ${result.load.status}):`,
    `Verdict: ${STATUS_HEADLINES[result.verdict.status]}`,
    `Route: ${result.route.distanceMiles} miles via ${result.route.provider} (truck-checked route: ${result.route.truckLegal ? "yes" : "no"}). Provider drive estimate ${duration(result.route.providerDurationMinutes)}; the plan drives ${duration(result.verdict.assumedDriveMinutes)} — ${result.verdict.driveTimeBasis}`,
  ];

  if (parity.deadhead) {
    const deadhead = parity.deadhead;
    let deadheadLine =
      `Deadhead: ${deadhead.distanceMiles} mi from ${deadhead.startLabel} — ` +
      `leave by ${formatEastern(new Date(deadhead.leaveByAt))}, ` +
      `reach the pickup ${formatEastern(new Date(deadhead.pickupArrivalAt))}.`;
    if (deadhead.waitMinutesAtPickup > 0) {
      deadheadLine +=
        ` Then ${formatMinutes(deadhead.waitMinutesAtPickup)} waiting at the pickup` +
        ` — it counts on your 14.`;
    }
    lines.push(deadheadLine);
    // leaveStartByAt is the deadhead story's leave-by (the pickup
    // tradeoff is makeItDepartureAt below) — only spoken with one.
    if (parity.verdict.leaveStartByAt) {
      lines.push(
        `Leave ${deadhead.startLabel ?? "the start"} by ${formatEastern(new Date(parity.verdict.leaveStartByAt))}`,
      );
    }
  }

  const sections: [string, string[]][] = [
    ["Legal", result.verdict.legalLines],
    ["Rested", result.verdict.restedLines],
    ["Paid", result.verdict.paidLines],
    ["Tradeoffs", result.verdict.tradeoffLines],
  ];
  for (const [label, section] of sections) {
    for (const line of section) lines.push(`${label}: ${line}`);
    if (label === "Rested" && parity.verdict.lifeLines && parity.verdict.lifeLines.length > 0) {
      lines.push("Your life on this run:");
      for (const line of parity.verdict.lifeLines) lines.push(line);
    }
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
    const workout = parity.plan?.workout;
    if (workout) {
      lines.push(
        workout.placed
          ? `Workout: ${workout.durationMinutes} min at ${workout.placeName ?? "a stop on the route"} — ${workout.note}`
          : `Workout: not placed — ${workout.note}`,
      );
    }
  } else {
    lines.push("Plan: no legal plan exists for this departure — see the legal lines above.");
  }

  if (result.fuel.candidates.length > 0) {
    lines.push(`Fuel (ranked by effective cost for ${result.fuel.assumptions.gallonsToBuy} gal):`);
    for (const candidate of result.fuel.candidates.slice(0, 3)) {
      lines.push(
        `- ${candidate.name}: ${fuelPriceText(candidate as FuelCandidateParity)}` +
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
      "Run the Smart Path route check on a RECORDED load (load_id from list_loads) — the same engine as the Smart Path page. It lays the load's route against his live duty clocks (paper-log helper), his truck profile, and the appointment windows, and returns one verdict — ON TIME / EARLY / LATE / NOT LEGAL — with the leave-by time, the breaks/rests it inserts, which routing engine served (and whether it was truck-checked), and fuel/food notes. It can also check from a start point before the pickup (start_location or start_point, with start_at) so the deadhead leg to the pickup is planned and timed too, and it can take life preferences (life: his sleep window and a workout break to fit) — the plan tries to fit them and says honestly when it can't. Origin, destination, truck, and clocks come from his records, never from parameters: if a forwarded load isn't recorded yet, record it first (or stage the dump and tell him the check runs once it's saved), then call this. Use whenever he asks 'can I make this load', 'when do I need to leave', or forwards a load and wants it planned.",
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
        start_location: {
          type: "string",
          description: "Where he is before the pickup (city/state or fuller address) — plans the deadhead leg to the pickup.",
        },
        start_point: {
          type: "object",
          description: "Start coordinates { lat, lng } if known (e.g. from a location fix); wins over start_location.",
          properties: { lat: { type: "number" }, lng: { type: "number" } },
          required: ["lat", "lng"],
        },
        start_at: {
          type: "string",
          description: "ISO timestamp he leaves the start. Omit for the just-in-time leave-by for the pickup departure.",
        },
        life: {
          type: "object",
          description:
            "Life preferences for the plan: sleep_start_hour / sleep_end_hour (Eastern, 0-23) and workout { want, minutes (30-180, default 60), setting: gym_preferred | any_safe_stop }.",
          properties: {
            sleep_start_hour: { type: "number" },
            sleep_end_hour: { type: "number" },
            workout: {
              type: "object",
              properties: {
                want: { type: "boolean" },
                minutes: { type: "number" },
                setting: { type: "string", enum: ["gym_preferred", "any_safe_stop"] },
              },
              required: ["want"],
            },
          },
        },
      },
      required: ["load_id"],
    },
    access: "read",
    async run(args) {
      const parsed = routeCheckToolArgs.parse(args);
      // The parity fields ride the same request object the endpoint
      // schema validates (start_* / life, P1-7/P1-9); the widened
      // annotation covers them until the schema type lands them.
      const request: RouteCheckRequest & {
        start_location?: string;
        start_point?: { lat: number; lng: number };
        start_at?: string;
        life?: RouteCheckToolInput["life"];
      } = {
        load_id: parsed.load_id,
        depart_at: parsed.depart_at ?? now().toISOString(),
        food_mode: parsed.food_mode ?? "grocery",
        ...(parsed.pickup_window ? { pickup_window: parsed.pickup_window } : {}),
        ...(parsed.delivery_window ? { delivery_window: parsed.delivery_window } : {}),
        ...(parsed.gallons_to_buy != null ? { gallons_to_buy: parsed.gallons_to_buy } : {}),
        ...(parsed.start_location ? { start_location: parsed.start_location } : {}),
        ...(parsed.start_point ? { start_point: parsed.start_point } : {}),
        ...(parsed.start_at ? { start_at: parsed.start_at } : {}),
        ...(parsed.life ? { life: parsed.life } : {}),
      };
      // Scoped to his company in code (the engine's companyId
      // parameter): on the Telegram surface the client is
      // service-role, where RLS alone would not scope these reads.
      const result = await runCheck(store.client, request, deps.providers, now(), store.companyId);
      return formatRouteCheck(result);
    },
  };
}
