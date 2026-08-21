// Tests the generic CRUD route factory once, with a mocked Supabase
// client - every MVP entity's route.ts files use this same factory
// (docs/api-contracts.md: "every other resource follows this exact
// shape"), so this covers all of them at once, the same reasoning
// tests/unit/services/api/handler.test.ts already applied to auth.

import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({
    userId: "u1",
    companyId: "company-1",
    role: "owner",
  }),
}));

function mockSupabase(result: { data?: unknown; error?: unknown; count?: number }) {
  const builder: Record<string, unknown> & { then: (resolve: (v: unknown) => void) => void } = {
    select: () => builder,
    is: () => builder,
    order: () => builder,
    range: () => builder,
    eq: () => builder,
    insert: () => builder,
    update: () => builder,
    single: () => builder,
    maybeSingle: () => builder,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return { from: () => builder };
}

vi.mock("@/services/db/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/services/db/server";
import { createCrudRoutes } from "@/services/api/crud-routes";

interface TestRow {
  id: string;
  name: string;
}

const schemas = { create: z.object({ name: z.string() }), update: z.object({ name: z.string() }).partial() };

describe("createCrudRoutes", () => {
  it("list: returns data + page envelope matching docs/api-contracts.md", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({ data: [{ id: "1", name: "a" }], count: 1 }) as never,
    );
    const routes = createCrudRoutes<TestRow>("things", schemas);

    const res = await routes.list(new NextRequest("http://localhost/api/v1/things"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ id: "1", name: "a" }],
      page: { limit: 50, offset: 0, total: 1 },
    });
  });

  it("create: validates the body before touching the database", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);
    const routes = createCrudRoutes<TestRow>("things", schemas);

    const req = new NextRequest("http://localhost/api/v1/things", {
      method: "POST",
      body: JSON.stringify({}), // missing required "name"
    });
    const res = await routes.create(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("create: 201 with the created row on valid input", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({ data: { id: "1", name: "a" } }) as never,
    );
    const routes = createCrudRoutes<TestRow>("things", schemas);

    const req = new NextRequest("http://localhost/api/v1/things", {
      method: "POST",
      body: JSON.stringify({ name: "a" }),
    });
    const res = await routes.create(req);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "1", name: "a" });
  });

  it("getOne: 404 (not 403) when the row doesn't exist or belongs to another company, per docs/api-contracts.md", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({ data: null }) as never);
    const routes = createCrudRoutes<TestRow>("things", schemas);

    const res = await routes.getOne(new NextRequest("http://localhost/api/v1/things/missing"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("remove: 204 with no body on success", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);
    const routes = createCrudRoutes<TestRow>("things", schemas);

    const res = await routes.remove(new NextRequest("http://localhost/api/v1/things/1"), {
      params: Promise.resolve({ id: "1" }),
    });

    expect(res.status).toBe(204);
  });
});
