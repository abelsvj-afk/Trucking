// Task 2.4 (TASKS.md). Verifies the shared pipeline itself rejects
// unauthenticated requests with the standard error shape before any
// handler logic runs, per docs/api-contracts.md - the mechanism every
// future business route relies on, tested here rather than per-route
// since no business route exists yet (that's Stage 3).

import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn(),
}));

import { getAuthContext } from "@/services/auth";
import { createApiHandler } from "@/services/api/handler";

describe("createApiHandler", () => {
  it("returns 401 with the standard error shape when there is no auth context", async () => {
    vi.mocked(getAuthContext).mockResolvedValue(null);

    const handler = createApiHandler(async () => {
      throw new Error("should never be called - auth check must short-circuit first");
    });

    const res = await handler(new NextRequest("http://localhost/api/v1/trucks"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Authentication required." },
    });
  });

  it("passes the resolved auth context through to the handler when present", async () => {
    vi.mocked(getAuthContext).mockResolvedValue({
      userId: "11111111-1111-1111-1111-111111111111",
      companyId: "22222222-2222-2222-2222-222222222222",
      role: "owner",
    });

    const handler = createApiHandler(async (_req, ctx) =>
      Response.json({ companyId: ctx.auth.companyId }) as never,
    );

    const res = await handler(new NextRequest("http://localhost/api/v1/trucks"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      companyId: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("never leaks a raw exception to the client", async () => {
    vi.mocked(getAuthContext).mockResolvedValue({
      userId: "u1",
      companyId: "c1",
      role: "owner",
    });

    const handler = createApiHandler(async () => {
      throw new Error("some internal detail that must never reach the client");
    });

    const res = await handler(new NextRequest("http://localhost/api/v1/trucks"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).not.toContain("internal detail");
    expect(body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
    });
  });
});
