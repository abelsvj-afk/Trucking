import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({ userId: "u1", companyId: "company-1", role: "owner" }),
}));

function mockSupabase(options: {
  companyResult?: { data?: unknown; error?: unknown };
  capabilitiesResult?: { data?: unknown; error?: unknown };
  upsertCalls?: unknown[];
  updateCalls?: unknown[];
}) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> & { then: (resolve: (v: unknown) => void) => void } = {
        select: () => builder,
        eq: () => builder,
        single: () => resolveFor(table),
        update: (values: unknown) => {
          options.updateCalls?.push(values);
          return builder;
        },
        upsert: (values: unknown) => {
          options.upsertCalls?.push(values);
          return { then: (resolve: (v: unknown) => void) => resolve({ error: null }) };
        },
        then: (resolve: (v: unknown) => void) => resolve(resolveFor(table)),
      };
      return builder;

      function resolveFor(t: string) {
        if (t === "companies") return options.companyResult ?? { data: { ai_globally_disabled: false } };
        if (t === "ai_capability_settings") return options.capabilitiesResult ?? { data: [] };
        return { data: null };
      }
    },
  };
}

vi.mock("@/services/db/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/services/db/server";
import { GET, PATCH } from "@/app/api/v1/ai-settings/route";

describe("GET /api/v1/ai-settings", () => {
  it("defaults every known capability to false when no rows exist", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);

    const res = await GET(new NextRequest("http://localhost/api/v1/ai-settings"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ globally_disabled: false, capabilities: { industry_intelligence: false } });
  });

  it("reflects a stored enabled capability and global switch", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        companyResult: { data: { ai_globally_disabled: true } },
        capabilitiesResult: { data: [{ capability: "industry_intelligence", enabled: true }] },
      }) as never,
    );

    const res = await GET(new NextRequest("http://localhost/api/v1/ai-settings"));
    const body = await res.json();

    expect(body).toEqual({ globally_disabled: true, capabilities: { industry_intelligence: true } });
  });
});

describe("PATCH /api/v1/ai-settings", () => {
  it("updates the global switch", async () => {
    const updateCalls: unknown[] = [];
    vi.mocked(createClient).mockResolvedValue(mockSupabase({ updateCalls }) as never);

    const res = await PATCH(
      new NextRequest("http://localhost/api/v1/ai-settings", {
        method: "PATCH",
        body: JSON.stringify({ globally_disabled: true }),
      }),
    );

    expect(res.status).toBe(200);
    expect(updateCalls).toContainEqual({ ai_globally_disabled: true });
  });

  it("upserts a capability's enabled state", async () => {
    const upsertCalls: unknown[] = [];
    vi.mocked(createClient).mockResolvedValue(mockSupabase({ upsertCalls }) as never);

    await PATCH(
      new NextRequest("http://localhost/api/v1/ai-settings", {
        method: "PATCH",
        body: JSON.stringify({ capabilities: { industry_intelligence: true } }),
      }),
    );

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      company_id: "company-1",
      capability: "industry_intelligence",
      enabled: true,
    });
  });

  it("rejects an unknown capability name", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);

    const res = await PATCH(
      new NextRequest("http://localhost/api/v1/ai-settings", {
        method: "PATCH",
        body: JSON.stringify({ capabilities: { made_up_capability: true } }),
      }),
    );

    expect(res.status).toBe(400);
  });
});
