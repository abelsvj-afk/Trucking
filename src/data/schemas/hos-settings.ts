import { z } from "zod";
import { PERIOD_ANCHOR_PATTERN } from "@/lib/hos-periods";
import { isValidTimeZone } from "@/lib/time";

// PATCH body for /api/v1/hos-settings (Reliability Unit B, B.5).
// Every field is optional (partial update, same contract as
// ai-settings); unknown fields are rejected by the route's strict
// parse path. Validation mirrors migration 00042's CHECK constraints
// so an invalid value fails as a 422 here instead of a database
// error there.

export const hosSettingsPatchSchema = z
  .object({
    hos_cycle: z.enum(["70/8", "60/7"]).optional(),
    hos_period_anchor: z
      .string()
      .regex(PERIOD_ANCHOR_PATTERN, 'Anchor must be a 24-hour "HH:MM" time')
      .optional(),
    hos_restart_enabled: z.boolean().optional(),
    hos_carrier_timezone: z
      .string()
      .refine((tz) => isValidTimeZone(tz), "Must be a valid IANA timezone")
      .optional(),
  })
  // Unknown keys are refused, not silently dropped: a settings write
  // that names a field this API does not own is a client bug, and the
  // refusal names the key (design B.5 field-named errors).
  .strict();
