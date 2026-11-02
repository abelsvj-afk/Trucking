// Generates the standard routes from docs/api-contracts.md
// (list/get/create/update/soft-delete) for one resource, wired through
// createApiHandler (auth + error handling) and the entity's own Zod
// schemas (validation). Every MVP entity's route.ts files are a few lines
// that call this - see src/app/api/v1/trucks/ for the worked example.
//
// Reliability Unit A/F extensions (accepted design, docs/
// reliability-wave1-design-package.md Units A + F):
// - DELETE is truthful: zero affected rows is a 404, not a silent 204.
// - POST accepts an idempotency token (submission_id) with a payload
//   fingerprint: same token + same payload replays the original create
//   (200, deduplicated), same token + different payload is a 409.
// - PATCH validates the MERGED record (existing row + patch) against
//   the create schema before writing, so a partial update can never
//   produce a record the create form would reject (F-028).
// - POST /[id]/restore restores a soft-deleted row behind safeguard
//   checks (schema validity, live FK parents) with named 422 refusals.
// - GET list supports ?deleted=only for the per-list Deleted view.

import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { createApiHandler } from "./handler";
import { validateBody } from "./validate";
import {
  ApiError,
  notFound,
  submissionConflict,
  unprocessableEntity,
  validationError,
  type FieldError,
} from "./errors";
import { createClient } from "@/services/db/server";
import { createCrudService } from "@/services/db/crud";
import {
  isSubmissionIndexViolation,
  payloadFingerprint,
} from "./submission";
import { restoreParentsFor } from "./entity-registry";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function issuesToFields(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

// Validate a STORED (or merged) record against a create schema.
// Storage and payloads disagree about "empty": the database stores
// NULL for every unset optional column, while most create schemas
// declare those fields .optional() (absent-or-value) rather than
// .nullable() - so a raw parse of a real row fails on every null,
// even though the record is exactly what a valid create produces.
// Two passes keep the guarantee honest: pass 1 parses the record as
// stored; pass 2 retries with null-valued keys removed (null reads
// as absent). A record is invalid only if BOTH fail - cross-field
// rules (pretrip's exactly-one-vehicle, loads' date order) fail both
// passes, because removing nulls cannot manufacture a value the rule
// needs. The 422, when it comes, reports pass 2's issues: the genuine
// rule violations, unobscured by null noise.
function validateStoredRecord(
  schema: z.ZodType<Record<string, unknown>>,
  record: Record<string, unknown>,
): { ok: true } | { ok: false; fields: FieldError[] } {
  if (schema.safeParse(record).success) return { ok: true };
  const withoutNulls = Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null),
  );
  const second = schema.safeParse(withoutNulls);
  if (second.success) return { ok: true };
  return { ok: false, fields: issuesToFields(second.error) };
}

export interface CrudRouteOptions {
  // Query-param names allowed as exact-match list filters, e.g. ["status"]
  // for loads (docs/api-contracts.md). Empty by default - most entities
  // don't need this.
  filterableFields?: string[];
  // Optional per-entity guard run against the MERGED record during a
  // PATCH, after merged-schema validation (Unit F) and before the write.
  // Returns an ApiError to refuse the update, or null to allow it.
  // Loads uses this for its status-transition rules (Unit A / F-016).
  validateMerged?: (
    merged: Record<string, unknown>,
    existing: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) => ApiError | null;
}

export function createCrudRoutes<Row extends { id: string }>(
  table: string,
  schemas: { create: z.ZodType<Record<string, unknown>>; update: z.ZodType<Record<string, unknown>> },
  options: CrudRouteOptions = {},
) {
  const crud = createCrudService<Row>(table);
  const filterableFields = options.filterableFields ?? [];

  const list = createApiHandler(async (req: NextRequest) => {
    const supabase = await createClient();
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const deletedOnly = url.searchParams.get("deleted") === "only";

    const filters: Record<string, string> = {};
    for (const field of filterableFields) {
      const value = url.searchParams.get(field);
      if (value) filters[field] = value;
    }

    const result = await crud.list(supabase, { limit, offset, filters, deletedOnly });
    return NextResponse.json({
      data: result.data,
      page: { limit: result.limit, offset: result.offset, total: result.total },
    });
  });

  const create = createApiHandler(async (req, ctx) => {
    const supabase = await createClient();

    // The body is parsed here rather than via validateBody because the
    // idempotency token rides alongside the entity payload and must be
    // read before schema validation strips unknown keys. Parse failures
    // and schema failures keep validateBody's exact 400 semantics.
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw validationError("Request body must be valid JSON.");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw validationError("Request body must be a JSON object.");
    }
    const rawBody = raw as Record<string, unknown>;

    let submissionId: string | null = null;
    if (rawBody.submission_id !== undefined && rawBody.submission_id !== null) {
      if (typeof rawBody.submission_id !== "string" || !UUID_RE.test(rawBody.submission_id)) {
        throw validationError("submission_id must be a UUID.");
      }
      submissionId = rawBody.submission_id;
    }

    const { submission_id: _submissionId, ...payload } = rawBody;
    const parsed = schemas.create.safeParse(payload);
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? "Invalid request body.");
    }
    const body = parsed.data;

    // No token: the original create path, unchanged. Bot/API writes
    // that don't send a token get no dedup guarantee (design A.6).
    if (!submissionId) {
      const row = await crud.create(supabase, ctx.auth.companyId, body);
      return NextResponse.json(row, { status: 201 });
    }

    const fingerprint = payloadFingerprint(body);
    try {
      const row = await crud.create(supabase, ctx.auth.companyId, {
        ...body,
        submission_id: submissionId,
        submission_payload_hash: fingerprint,
      });
      return NextResponse.json(row, { status: 201 });
    } catch (err) {
      // Only a violation of THIS table's named idempotency index enters
      // the dedup path; every other error is its own error (A.6).
      if (!isSubmissionIndexViolation(err, table)) throw err;

      const existing = (await crud.findBySubmission(
        supabase,
        ctx.auth.companyId,
        submissionId,
      )) as (Row & { submission_payload_hash?: string | null }) | null;
      if (!existing) throw err;

      if (existing.submission_payload_hash === fingerprint) {
        // A true replay: return the original create's outcome.
        return NextResponse.json({ ...existing, deduplicated: true }, { status: 200 });
      }
      // Same token, different payload: a client error. No row was
      // created and the original is never presented as this result.
      throw submissionConflict();
    }
  });

  const getOne = createApiHandler(async (_req, ctx) => {
    const supabase = await createClient();
    const row = await crud.get(supabase, ctx.params.id!);
    if (!row) throw notFound();
    return NextResponse.json(row);
  });

  const update = createApiHandler(async (req, ctx) => {
    const supabase = await createClient();
    const id = ctx.params.id!;

    // Unit F step 1: shape-check the patch itself (400s, as before).
    const patch = await validateBody(req, schemas.update);

    // Step 2: load the existing row under RLS. Absent (or another
    // company's) -> 404 BEFORE any validation detail can leak.
    const existing = await crud.get(supabase, id);
    if (!existing) throw notFound();

    // Step 3: merge and validate the FULL record against the create
    // schema. A failure here is a 422 with field-level errors; the
    // database is never touched.
    const merged: Record<string, unknown> = {
      ...(existing as Record<string, unknown>),
      ...patch,
    };
    const mergedCheck = validateStoredRecord(schemas.create, merged);
    if (!mergedCheck.ok) {
      throw unprocessableEntity("The updated record would be invalid.", mergedCheck.fields);
    }

    // Per-entity merged-record guard (e.g. load status transitions).
    if (options.validateMerged) {
      const refusal = options.validateMerged(
        merged,
        existing as Record<string, unknown>,
        patch,
      );
      if (refusal) throw refusal;
    }

    // Step 4: write ONLY the patched fields - the merge exists for
    // validation, not for rewriting untouched columns.
    const row = await crud.update(supabase, id, patch);
    if (!row) throw notFound();
    return NextResponse.json(row);
  });

  const remove = createApiHandler(async (_req, ctx) => {
    const supabase = await createClient();
    const deleted = await crud.softDelete(supabase, ctx.params.id!);
    // Truthful delete (F-005): deleting a nonexistent, already-deleted,
    // or other-company record reports 404, never a silent 204.
    if (!deleted) throw notFound();
    return new NextResponse(null, { status: 204 });
  });

  const restore = createApiHandler(async (_req, ctx) => {
    const supabase = await createClient();
    const id = ctx.params.id!;

    const row = await crud.getIncludingDeleted(supabase, id);
    if (!row) throw notFound();

    // Not deleted: there is nothing to restore; answer with the current
    // state rather than pretending a transition happened (A.5.4).
    if ((row as { deleted_at?: string | null }).deleted_at == null) {
      return NextResponse.json(row);
    }

    // Safeguard 1 (A.4): the record must still validate against its
    // create schema (same stored-record validation as the update
    // path - storage nulls are not validation failures).
    const recordCheck = validateStoredRecord(
      schemas.create,
      row as Record<string, unknown>,
    );
    if (!recordCheck.ok) {
      throw unprocessableEntity(
        "Cannot restore: this record no longer passes validation.",
        recordCheck.fields,
      );
    }

    // Safeguard 2 (A.4): every FK parent it references must still exist
    // and not itself be soft-deleted. Runs under the caller's RLS, so a
    // parent belonging to another company reads as nonexistent - the
    // non-leaking answer either way.
    for (const parent of restoreParentsFor(table)) {
      const parentId = (row as Record<string, unknown>)[parent.field];
      if (typeof parentId !== "string" || !parentId) continue;
      const { data: parentRow, error: parentError } = await supabase
        .from(parent.parentTable)
        .select("id, deleted_at")
        .eq("id", parentId)
        .maybeSingle();
      if (parentError) throw parentError;
      if (!parentRow) {
        throw unprocessableEntity(
          `Cannot restore: its ${parent.parentLabel} no longer exists.`,
        );
      }
      if ((parentRow as { deleted_at: string | null }).deleted_at != null) {
        throw unprocessableEntity(
          `Cannot restore: its ${parent.parentLabel} was deleted — restore the ${parent.parentLabel} first.`,
        );
      }
    }

    // Safeguard 3 (A.4): no uniqueness conflict may result. No natural
    // unique indexes exist on these tables today, so this is the
    // update's own constraint error, translated - never a raw DB error.
    try {
      const restored = await crud.restore(supabase, id);
      if (!restored) throw notFound();
      return NextResponse.json(restored);
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: unknown }).code === "23505"
      ) {
        throw unprocessableEntity(
          "Cannot restore: restoring would conflict with an existing record.",
        );
      }
      throw err;
    }
  });

  return { list, create, getOne, update, remove, restore };
}
