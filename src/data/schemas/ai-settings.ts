import { z } from "zod";
import { INDUSTRY_INTELLIGENCE_CAPABILITY } from "@/services/ai/run-industry-briefing";
import { DISPATCH_HELPER_CAPABILITY } from "@/services/ai/dispatch";
import { DEEP_RESEARCH_CAPABILITY } from "@/services/research/run-research";

// Every capability that has a kill switch (docs/governance.md). Extend
// this as each new capability is built - an unknown capability name in a
// PATCH body is rejected, not silently stored, so this list stays the
// source of truth for what's actually controllable.
export const KNOWN_CAPABILITIES = [
  INDUSTRY_INTELLIGENCE_CAPABILITY,
  DISPATCH_HELPER_CAPABILITY,
  DEEP_RESEARCH_CAPABILITY,
] as const;

export const aiSettingsPatchSchema = z.object({
  globally_disabled: z.boolean().optional(),
  // partialRecord, not record: the PATCH body is any SUBSET of
  // capabilities (docs/api-contracts.md). A plain z.record over the
  // enum would demand every known key once more than one capability
  // exists - that broke silently when dispatch_helper was added as the
  // second capability (caught by ai-settings-route.test.ts).
  capabilities: z.partialRecord(z.enum(KNOWN_CAPABILITIES), z.boolean()).optional(),
});
