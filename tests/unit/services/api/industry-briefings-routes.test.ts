import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({ userId: "u1", companyId: "company-1", role: "owner" }),
}));

function mockSupabase(resultsByTable: Record<string, { data?: unknown; error?: unknown }>) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> & { then: (resolve: (v: unknown) => void) => void } = {
        select: () => builder,
        is: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        update: () => builder,
        maybeSingle: () => builder,
        then: (resolve: (v: unknown) => void) => resolve(resultsByTable[table] ?? { data: [] }),
      };
      return builder;
    },
  };
}

vi.mock("@/services/db/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/services/db/server";
import { GET } from "@/app/api/v1/industry-briefings/route";
import { POST as dismiss } from "@/app/api/v1/industry-briefings/[id]/dismiss/route";

describe("GET /api/v1/industry-briefings", () => {
  it("returns briefings plus a service_status with 0 consecutive failures when the latest run succeeded", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        industry_briefings: { data: [{ id: "b1", summary: "s" }] },
        industry_briefing_runs: {
          data: [
            { started_at: "2026-08-21T00:00:00Z", status: "success" },
            { started_at: "2026-08-20T00:00:00Z", status: "failure" },
          ],
        },
      }) as never,
    );

    const res = await GET(new NextRequest("http://localhost/api/v1/industry-briefings"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([{ id: "b1", summary: "s" }]);
    expect(body.service_status).toEqual({
      consecutive_failures: 0,
      escalated: false,
      last_run_at: "2026-08-21T00:00:00Z",
    });
  });

  it("counts consecutive failures from the most recent run and escalates at the threshold", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        industry_briefings: { data: [] },
        industry_briefing_runs: {
          data: [
            { started_at: "2026-08-21T00:00:00Z", status: "failure" },
            { started_at: "2026-08-20T00:00:00Z", status: "failure" },
            { started_at: "2026-08-19T00:00:00Z", status: "failure" },
            { started_at: "2026-08-18T00:00:00Z", status: "success" },
          ],
        },
      }) as never,
    );

    const res = await GET(new NextRequest("http://localhost/api/v1/industry-briefings"));
    const body = await res.json();

    expect(body.service_status.consecutive_failures).toBe(3);
    expect(body.service_status.escalated).toBe(true);
  });

  it("does not escalate below the threshold", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        industry_briefings: { data: [] },
        industry_briefing_runs: {
          data: [
            { started_at: "2026-08-21T00:00:00Z", status: "failure" },
            { started_at: "2026-08-20T00:00:00Z", status: "success" },
          ],
        },
      }) as never,
    );

    const res = await GET(new NextRequest("http://localhost/api/v1/industry-briefings"));
    const body = await res.json();

    expect(body.service_status.consecutive_failures).toBe(1);
    expect(body.service_status.escalated).toBe(false);
  });

  it("handles no run history at all", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        industry_briefings: { data: [] },
        industry_briefing_runs: { data: [] },
      }) as never,
    );

    const res = await GET(new NextRequest("http://localhost/api/v1/industry-briefings"));
    const body = await res.json();

    expect(body.service_status).toEqual({ consecutive_failures: 0, escalated: false, last_run_at: null });
  });

  it("does not count an insufficient_data run as a failure", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        industry_briefings: { data: [] },
        industry_briefing_runs: {
          data: [
            { started_at: "2026-08-21T00:00:00Z", status: "insufficient_data" },
            { started_at: "2026-08-20T00:00:00Z", status: "failure" },
          ],
        },
      }) as never,
    );

    const res = await GET(new NextRequest("http://localhost/api/v1/industry-briefings"));
    const body = await res.json();

    expect(body.service_status.consecutive_failures).toBe(0);
  });
});

describe("POST /api/v1/industry-briefings/{id}/dismiss", () => {
  it("sets dismissed_at and returns the updated row", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({ industry_briefings: { data: { id: "b1", dismissed_at: "2026-08-21T00:00:00Z" } } }) as never,
    );

    const res = await dismiss(new NextRequest("http://localhost/api/v1/industry-briefings/b1/dismiss", { method: "POST" }), {
      params: Promise.resolve({ id: "b1" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).dismissed_at).toBe("2026-08-21T00:00:00Z");
  });

  it("404s when the briefing doesn't exist, belongs to another company, or is already dismissed", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({ industry_briefings: { data: null } }) as never);

    const res = await dismiss(new NextRequest("http://localhost/api/v1/industry-briefings/missing/dismiss", { method: "POST" }), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(res.status).toBe(404);
  });
});
