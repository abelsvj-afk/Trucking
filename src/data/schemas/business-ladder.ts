import { z } from "zod";

export const ladderStepStateSchema = z.enum(["not_started", "in_progress", "done"]);

export const updateLadderStepSchema = z.object({
  state: ladderStepStateSchema,
  note: z.string().nullable().optional(),
});
