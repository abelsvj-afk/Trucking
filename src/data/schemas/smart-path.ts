// Smart Path v1 (docs/design/driver-mvp.md §8.3). Validation for the
// route-check endpoint - the enforcement point for the contract in
// docs/api-contracts.md, checked in validateBody() before any
// provider or database call happens.

import { z } from "zod";

const isoTimestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "must be an ISO timestamp.");

export const timeWindowSchema = z
  .object({
    start: isoTimestamp,
    end: isoTimestamp,
  })
  .refine((window) => Date.parse(window.start) < Date.parse(window.end), {
    message: "window start must be before window end.",
  });

export const routeCheckRequestSchema = z.object({
  load_id: z.string().uuid("load_id must be a load id."),
  depart_at: isoTimestamp,
  // Piece 1 (P1-7): where the run actually starts, before the pickup.
  // All optional - absence is today's pickup-only behavior exactly.
  // start_point (from the one-shot "where I am" fix) wins over
  // start_location (geocoded server-side) when both are given.
  start_location: z.string().trim().min(3).max(200).optional(),
  start_point: z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .optional(),
  start_at: isoTimestamp.optional(),
  // Reroute (audit D4, 2026-11-05): the load is already picked up, so with
  // a start_point the run is routed from HERE straight to the destination
  // - no pickup leg. Ignored without a start_point.
  already_picked_up: z.boolean().optional(),
  // Piece 1 (P1-9): per-request life preferences - sleep window and
  // a workout break the planner should try to fit. Absent = today's
  // behavior with today's defaults.
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
  pickup_window: timeWindowSchema.optional(),
  delivery_window: timeWindowSchema.optional(),
  // Owner 2026-11-17: he runs on his carrier's ELD; when the app's own log is behind, he can give the ELD's clocks.
  // They are counted down from entered_at (conservatively, as if every minute since were on duty).
  eld_clocks: z
    .object({
      drive_left_min: z.number().int().min(0).max(11 * 60),
      window_left_min: z.number().int().min(0).max(14 * 60),
      cycle_left_min: z.number().int().min(0).max(70 * 60),
      break_left_min: z.number().int().min(0).max(8 * 60).optional(),
      entered_at: isoTimestamp,
    })
    .optional(),
  // Live awareness (owner 2026-11-17): avoid circles around a
  // reported delay, for a truck-checked detour. Applied to the
  // loaded leg only. A car-route fallback refuses avoid outright
  // (routing.ts) - a car detour is never presented as truck-safe.
  avoid: z
    .array(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusMiles: z.number().positive().max(50),
      }),
    )
    .max(5)
    .optional(),
  food_mode: z.enum(["grocery", "fast_food"]).default("grocery"),
  gallons_to_buy: z
    .number()
    .positive("gallons_to_buy must be positive.")
    .max(300, "gallons_to_buy is larger than any truck tank.")
    .optional(),
});

export type RouteCheckRequest = z.infer<typeof routeCheckRequestSchema>;

const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// Live awareness (owner 2026-11-17): the live-traffic poll while
// driving. Geometry, corridor and miles are the REMAINING run:
// mile 0 is his position. The detour comparison needs the
// destination (and the truck's dimensions when known); without a
// detour to compare, the call falls back to the clears-before-you-
// get-there and delay-size rules and says so.
export const liveTrafficRequestSchema = z.object({
  geometry: z.array(latLngSchema).min(2).max(2000),
  totalMiles: z.number().positive().max(3000),
  corridor: z
    .array(z.object({ mile: z.number().min(0), etaAt: isoTimestamp.nullable() }))
    .min(1)
    .max(200),
  currentMile: z.number().min(0).default(0),
  currentPoint: latLngSchema,
  destination: latLngSchema,
  vehicle: z
    .object({
      heightIn: z.number().positive().max(200).nullable(),
      lengthIn: z.number().positive().max(1200).nullable(),
      weightLbs: z.number().positive().max(200000).nullable(),
    })
    .nullable()
    .optional(),
  plannedRemainingMinutes: z.number().positive().max(24 * 60).nullable().optional(),
});

export type LiveTrafficRequest = z.infer<typeof liveTrafficRequestSchema>;

// Drive map (audit-fix B7, 2026-11-18): truck POIs along the run
// while driving. Geometry and miles are the REMAINING run: mile 0
// is his position, and the answer's miles are relative to it — the
// page shifts them by what he has already driven.
export const truckPoisRequestSchema = z.object({
  geometry: z.array(latLngSchema).min(2).max(2000),
  totalMiles: z.number().positive().max(3000),
});

export type TruckPoisRequest = z.infer<typeof truckPoisRequestSchema>;
