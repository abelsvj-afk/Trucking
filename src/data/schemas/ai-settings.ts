import { z } from "zod";
import { INDUSTRY_INTELLIGENCE_CAPABILITY } from "@/services/ai/run-industry-briefing";

// Every capability that has a kill switch (docs/governance.md). Extend
// this as each new capability is built - an unknown capability name in a
// PATCH body is rejected, not silently stored, so this list stays the
// source of truth for what's actually controllable.
export const KNOWN_CAPABILITIES = [INDUSTRY_INTELLIGENCE_CAPABILITY] as const;

export const aiSettingsPatchSchema = z.object({
  globally_disabled: z.boolean().optional(),
  capabilities: z.record(z.enum(KNOWN_CAPABILITIES), z.boolean()).optional(),
});
