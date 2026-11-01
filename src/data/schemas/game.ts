import { z } from "zod";

// Gaming System request bodies (docs/design/gaming-system.md,
// contracts in docs/api-contracts.md). Money is integer cents
// everywhere, matching the schema convention.

export const gameMetricSchema = z.enum([
  "monthly_net_cents",
  "truck_fund_cents",
  "business_value_cents",
  "net_worth_cents",
]);

export const gamePostureSchema = z.enum(["conservative", "mixed"]);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in YYYY-MM-DD format");
const monthString = z.string().regex(/^\d{4}-\d{2}$/, "must be a month in YYYY-MM format");

export const createGameTargetSchema = z.object({
  metric: gameMetricSchema,
  target_value_cents: z.number().int().positive(),
  target_date: dateString.nullable().optional(),
  posture: gamePostureSchema,
  posture_mix_pct: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const updateGameTargetSchema = z
  .object({
    metric: gameMetricSchema.optional(),
    target_value_cents: z.number().int().positive().optional(),
    target_date: dateString.nullable().optional(),
    posture: gamePostureSchema.optional(),
    posture_mix_pct: z.number().int().min(0).max(100).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update." });

// A side-income lever (design §3.4): real only with a citation (a
// research briefing id or one of his recorded skills) and recorded
// numbers. The engine re-checks the citation against the snapshot's
// candidates - a lever citing nothing is dropped there too.
export const sideLeverSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  sourceType: z.enum(["briefing", "memory"]),
  sourceId: z.string().min(1),
  monthlyLowCents: z.number().int().min(0),
  monthlyHighCents: z.number().int().min(0),
  hoursPerWeek: z.number().min(0).max(80),
  startupCents: z.number().int().min(0),
  seasonality: z.string().max(200).nullable().optional(),
  startMonth: monthString.nullable().optional(),
});

// Conversational/UI what-ifs (design §2.3): assumption overrides,
// never real data. Every key is optional; unknown keys are rejected
// by the object shape, not silently stored.
export const gameOverridesSchema = z
  .object({
    fuel_price_cents_gal: z.number().int().min(0).optional(),
    sweep_pct: z.number().min(0).max(100).optional(),
    truck_price_cents: z.number().int().positive().optional(),
    repair_reserve_cents: z.number().int().min(0).optional(),
    authority_startup_cents: z.number().int().min(0).optional(),
    insurance_annual_cents: z.number().int().min(0).optional(),
    factoring_pct: z.number().min(0).max(100).optional(),
    truck_financing_cents: z.number().int().min(0).optional(),
    authority_activation_month: monthString.nullable().optional(),
    materiality_pct: z.number().min(0).max(50).optional(),
    side_income_levers: z.array(sideLeverSchema).max(10).optional(),
  })
  .strict();

export const whatIfRequestSchema = z.object({
  overrides: gameOverridesSchema,
});

export const regameRequestSchema = z.object({
  trigger: z
    .enum(["manual", "target_set", "target_edit", "checkpoint"])
    .optional(),
});

export const promoteRequestSchema = z.object({
  plan_id: z.string().uuid(),
});
