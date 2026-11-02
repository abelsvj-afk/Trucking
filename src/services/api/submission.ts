// Idempotent-create support (Reliability Unit A / F-006, design A.6).
//
// A create form generates one submission token (UUID) when it opens and
// sends it as `submission_id`. The server stores the token plus a
// fingerprint of the VALIDATED payload; a retry carrying the same token
// is then decidable exactly:
//   same token + same fingerprint  -> the original create, replayed
//   same token + other fingerprint -> a client error (409), never a
//                                     silent return of the original
//   different/no token             -> a fresh create, always allowed
//
// The fingerprint is computed over the payload AFTER Zod validation and
// coercion, serialized canonically (object keys sorted recursively), so
// benign serialization differences - key order, whitespace, number
// formatting in the raw JSON - cannot produce false conflicts.

import { createHash } from "node:crypto";

/** The named partial unique index migration 00029 creates per table. */
export function submissionIndexName(table: string): string {
  return `${table}_submission_idempotency`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function payloadFingerprint(validatedPayload: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalize(validatedPayload));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * True when a database error is a unique-violation on THIS table's
 * idempotency index - the only constraint whose violation may enter the
 * dedup path (design A.6). Any other unique violation (or an unnamed
 * one) is that constraint's own error, never a replay.
 */
export function isSubmissionIndexViolation(error: unknown, table: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: unknown; message?: unknown; details?: unknown };
  if (err.code !== "23505") return false;
  const haystack = `${String(err.message ?? "")} ${String(err.details ?? "")}`;
  return haystack.includes(submissionIndexName(table));
}
