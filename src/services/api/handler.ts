// Task 2.2 (TASKS.md). The shared request pipeline every business route
// passes through, per docs/service-specs.md: auth check -> handler ->
// centralized error formatting. Input validation is each handler's own
// responsibility (via validate.ts), since the shape being validated
// differs per route. GET /api/v1/health is the one documented exception
// (docs/api-contracts.md) and does not use this wrapper.

import { NextRequest, NextResponse } from "next/server";
import { getAuthContext, type AuthContext } from "@/services/auth";
import { ApiError, unauthorized } from "./errors";

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
          { error: { code: err.code, message: err.message } },
          { status: err.status },
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
