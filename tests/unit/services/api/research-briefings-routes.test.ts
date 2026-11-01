import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({ userId: "u1", companyId: "company-1", role: "owner" }),
}));

function mockSupabase(resultsByTable: Record<string, { data?: unknown; count?: number; single?: unknown }>) {
  return {
    from: (table: string) => {
      const result = resultsByTable[table] ?? { data: [] };
      const builder: Record<string, unknown> = {
        select: () => builder,
        is: () => builder,
        eq: () => builder,
        in: () => builder,
        gte: () => builder,
        order: () => builder,
        limit: () => builder,
        update: () => builder,
        insert: () => builder,
        maybeSingle: async () => result.single ?? { data: null, error: null },
        single: async () => result.single ?? { data: null, error: null },
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: result.data ?? [], count: result.count ?? null, error: null }),
      };
      return builder;
    },
  };
}

vi.mock("@/services/db/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/services/db/server";
import { GET } from "@/app/api/v1/research-briefings/route";
import { POST as researchNow } from "@/app/api/v1/research-briefings/research-now/route";
import { POST as markRead } from "@/app/api/v1/research-briefings/[id]/read/route";

const BRIEFING = {
  id: "b1",
  title: "Diesel spiked",
  headline: "h",
  findings: [],
  read_at: null,
  dismissed_at: null,
  created_at: "2026-10-31T00:00:00Z",
};

describe("GET /api/v1/research-briefings", () => {
  it("returns briefings with unread count, run log, watcher health, and cap usage", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        research_briefings: { data: [BRIEFING], count: 1 },
        research_runs: {
          data: [{ id: "r1", status: "success", topic: "fuel" }],
          count: 3,
        },
        research_watcher_state: {
          data: [{ watcher_key: "eia_diesel", last_status: "skipped", last_error: "EIA_API_KEY is not set" }],
        },
      }) as never,
    );

    const res = await GET(new NextRequest("http://localhost/api/v1/research-briefings"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([BRIEFING]);
    expect(body.unread_count).toBe(1);
    expect(body.runs).toHaveLength(1);
    expect(body.watchers[0].last_status).toBe("skipped");
    expect(body.usage.runs_today).toBe(3);
    expect(body.usage.max_runs_per_day).toBeGreaterThan(0);
  });
});

describe("POST /api/v1/research-briefings/research-now", () => {
  it("queues a manual run (201) for a valid topic", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        research_runs: { single: { data: { id: "q1", trigger_kind: "manual", status: "queued", topic: "factoring" } } },
      }) as never,
    );

    const req = new NextRequest("http://localhost/api/v1/research-briefings/research-now", {
      method: "POST",
      body: JSON.stringify({ topic: "factoring" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await researchNow(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.status).toBe("queued");
    expect(body.trigger_kind).toBe("manual");
  });

  it("rejects a topic that's too short", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);
    const req = new NextRequest("http://localhost/api/v1/research-briefings/research-now", {
      method: "POST",
      body: JSON.stringify({ topic: "ab" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await researchNow(req);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/research-briefings/[id]/read", () => {
  it("marks the briefing read, clearing its unread state", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        research_briefings: { single: { data: { ...BRIEFING, read_at: "2026-10-31T13:00:00Z" } } },
      }) as never,
    );

    const res = await markRead(new NextRequest("http://localhost/api/v1/research-briefings/b1/read", { method: "POST" }), {
      params: Promise.resolve({ id: "b1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.read_at).not.toBeNull();
  });

  it("404s when the briefing isn't the owner's (or doesn't exist)", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({ research_briefings: { single: { data: null } } }) as never,
    );
    const res = await markRead(new NextRequest("http://localhost/api/v1/research-briefings/nope/read", { method: "POST" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});
