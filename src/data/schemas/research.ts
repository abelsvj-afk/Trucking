import { z } from "zod";

// The owner's manual trigger (docs/design/research-engine.md §6): a
// free-text topic he'll research - bounded so a paste-bomb doesn't
// become a prompt-bomb, rejected (not trimmed-and-hoped) per CLAUDE.md.
export const researchNowSchema = z.object({
  topic: z.string().trim().min(3, "Give the research a topic of at least a few characters.").max(200),
});
