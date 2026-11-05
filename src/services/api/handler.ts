// Task 2.2 (TASKS.md). The shared request pipeline every business route
// passes through, per docs/service-specs.md: auth check -> handler ->
// centralized error formatting. Input validation is each handler's own
// responsibility (via validate.ts), since the shape being validated
// differs per route. GET /api/v1/health is the one documented exception
// (docs/api-contracts.md) and does not use this wrapper.

import { NextRequest, NextResponse } from "next/server";
import { getAuthContext, type AuthContext } from "@/services/auth";
import { ApiError, unauthorized, unprocessableEntity } from "./errors";

/**
 * Reliability Unit E: the database's tenant-integrity backstop (composite foreign keys,
 * documents reference trigger) refuses a reference to a record that is not in the caller's
 * account. Surfaced as ONE uniform 422 - never the raw constraint error, and never whether the
 * record exists in someone else's account (CLAUDE.md: no leakage, no existence oracle).
 */
export function tenantIntegrityError(err: unknown): ApiError | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, message } = err as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  if (code === "23503" && /still referenced/i.test(text)) {
    return unprocessableEntity("This record is still in use by other records, so it can't be removed.");
  }
  if (code === "23503" || (code === "23514" && /invalid document reference/i.test(text))) {
    return unprocessableEntity("One of the records this refers to wasn't found in your account.");
  }
  return null;
}

type RouteContext = { params: Promise<Record<string, string>> };

type Handler = (
  req: NextRequest,
  ctx: { auth: AuthContext; params: Record<string, string> },
) => Promise<NextResponse>;

export function createApiHandler(handler: Handler) {
  return async (
    req: NextRequest,
    routeCtx: RouteContext = { params: Promise.resolve({}) },
  ): Promise<NextResponse> => {
    try {
      const auth = await getAuthContext();
      if (!auth) throw unauthorized();

      const params = await routeCtx.params;
      return await handler(req, { auth, params });
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json(
          {
            error: {
              code: err.code,
              message: err.message,
              // Field-level detail when the error carries it (Unit A/F
              // 422s); omitted entirely otherwise, keeping the original
              // body shape for every pre-existing error.
              ...(err.fields ? { fields: err.fields } : {}),
            },
          },
          { status: err.status },
        );
      }

      const integrity = tenantIntegrityError(err);
      if (integrity) {
        return NextResponse.json(
          { error: { code: integrity.code, message: integrity.message } },
          { status: integrity.status },
        );
      }

      // Never leak the raw exception to the client, per CLAUDE.md's
      // centralized error handling rule - real detail goes to the server
      // log only.
      console.error("[api] unhandled error", err);
      return NextResponse.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred.",
          },
        },
        { status: 500 },
      );
    }
  };
}
