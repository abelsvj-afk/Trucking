// Shared request-body validation, per docs/service-specs.md's services/api
// spec and CLAUDE.md's "reject, don't sanitize-and-hope" rule. Each route
// supplies its own Zod schema (Phase 15+, as each entity gets built).

import type { z } from "zod";
import { validationError } from "./errors";

export async function validateBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw validationError("Request body must be valid JSON.");
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    throw validationError(result.error.issues[0]?.message ?? "Invalid request body.");
  }
  return result.data;
}
