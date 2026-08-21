// Task 4.2 (TASKS.md), per docs/design/ai-architecture.md's Output
// contract section. Every AI capability's raw provider response gets
// parsed through this - a capability that can't meet the confidence/
// based_on bar returns "insufficient_data" instead of a weak "ok" with
// invented content (CLAUDE.md's "AI must not invent unavailable data").

import { z } from "zod";

export const aiOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    confidence: z.enum(["high", "medium", "low"]),
    based_on: z.array(z.string()).min(1, "based_on must name at least one real source."),
    options: z
      .array(
        z.object({
          summary: z.string().min(1),
          reasoning: z.string().min(1),
          confidence: z.enum(["high", "medium", "low"]),
          based_on: z.array(z.string()).min(1),
        }),
      )
      .optional(),
  }),
  z.object({
    status: z.literal("insufficient_data"),
    reason: z.string().min(1),
  }),
]);

export type AiOutput = z.infer<typeof aiOutputSchema>;

/**
 * Parses a provider's raw text response against the shared output
 * contract. Untrusted model output (CLAUDE.md) - never trusted without
 * this validation, regardless of how confident the JSON looks.
 */
export function parseAiOutput(raw: string): AiOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("AI response was not valid JSON.");
  }

  const result = aiOutputSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`AI response didn't match the output contract: ${result.error.message}`);
  }
  return result.data;
}
