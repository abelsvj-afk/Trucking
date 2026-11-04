import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Home News Banner (2026-11-02 design §§4-6): the extended list
// payload (signals + engine_enabled), the by-id deep-link fallback,
// and the check-wires light pull's honest states.

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({ userId: "u1", companyId: "company-1", role: "owner" }),
}));

type TableResult = { data?: unknown; count?: number; single?: unknown };

function mockSupabase(resultsByTable: Record<string, TableResult>) {
  return {
    from: (table: string) => {
      const result = resultsByTable[table] ?? { data: [] };
      const builder: Record<string, unknown> = {
        select: () => builder,
        is: () => builder,
        eq: () => builder,
        in: () => builder,
        not: () => builder,
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

vi.mock("@/services/db/server", () => ({ createClient: vi.fn() }));
vi.mock("@/services/db/industry-briefing-pool", () => ({ getIndustryBriefingPool: vi.fn() }));
vi.mock("@/services/research/watchers", () => ({ pollAllWatchers: vi.fn() }));

import { createClient } from "@/services/db/server";
import { getIndustryBriefingPool } from "@/services/db/industry-briefing-pool";
import { pollAllWatchers } from "@/services/research/watchers";
import { GET } from "@/app/api/v1/research-briefings/route";
import { GET as getBriefingById } from "@/app/api/v1/research-briefings/[id]/route";
import { POST as checkWires } from "@/app/api/v1/research-briefings/check-wires/route";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const HOUR = 3600 * 1000;

const ENABLED_TABLES: Record<string, TableResult> = {
  companies: { single: { data: { ai_globally_disabled: false }, error: null } },
  ai_capability_settings: { single: { data: { enabled: true }, error: null } },
};

function signalRow(partial: Record<string, unknown>) {
  return {
    id: "s1",
    watcher_key: "eia_diesel",
    kind: "fuel_price_observation",
    topic: "fuel",
    magnitude: 0.8,
    summary: "Diesel moving",
    items: [],
    observed_at: iso(1 * HOUR),
    dedupe_key: "k1",
    ...partial,
  };
}

describe("GET /api/v1/research-briefings - banner payload", () => {
  it("adds engine_enabled and the banner-eligible signals only", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        ...ENABLED_TABLES,
        research_briefings: { data: [], count: 0 },
        research_runs: {
          // Serves both the run list and the trigger_detail query in
          // this fake: one success run consumed dedupe key "used".
          data: [
            {
              id: "r1",
              status: "success",
              topic: "fuel",
              trigger_detail: { signal_dedupe_keys: ["used"] },
            },
          ],
          count: 0,
        },
        research_watcher_state: { data: [] },
        research_signals: {
          data: [
            signalRow({ id: "fresh", dedupe_key: "k-fresh" }),
            signalRow({ id: "consumed", dedupe_key: "used" }),
            signalRow({ id: "weak", dedupe_key: "k-weak", magnitude: 0.4 }),
            signalRow({ id: "stale", dedupe_key: "k-stale", observed_at: iso(80 * HOUR) }),
          ],
        },
      }) as never,
    );

    const res = await GET(new NextRequest("http://localhost/api/v1/research-briefings"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.engine_enabled).toBe(true);
    expect(body.signals.map((s: { id: string }) => s.id)).toEqual(["fresh"]);
  });

  it("engine_enabled is false when the capability row is off", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        companies: { single: { data: { ai_globally_disabled: false }, error: null } },
        ai_capability_settings: { single: { data: { enabled: false }, error: null } },
        research_briefings: { data: [], count: 0 },
        research_runs: { data: [], count: 0 },
        research_watcher_state: { data: [] },
        research_signals: { data: [] },
      }) as never,
    );

    const res = await GET(new NextRequest("http://localhost/api/v1/research-briefings"));
    const body = await res.json();
    expect(body.engine_enabled).toBe(false);
    expect(body.signals).toEqual([]);
  });
});

describe("GET /api/v1/research-briefings/[id]", () => {
  it("returns a dismissed briefing (the deep-link fallback)", async () => {
    const dismissed = { id: "b9", title: "Old news", dismissed_at: "2026-11-01T00:00:00Z" };
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({ research_briefings: { single: { data: dismissed, error: null } } }) as never,
    );

    const res = await getBriefingById(
      new NextRequest("http://localhost/api/v1/research-briefings/b9"),
      { params: Promise.resolve({ id: "b9" }) },
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.id).toBe("b9");
    expect(body.dismissed_at).not.toBeNull();
  });

  it("404s for a briefing that isn't his", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({ research_briefings: { single: { data: null, error: null } } }) as never,
    );
    const res = await getBriefingById(
      new NextRequest("http://localhost/api/v1/research-briefings/nope"),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/research-briefings/check-wires", () => {
  const queryLog: string[] = [];

  function fakePool(locked: boolean) {
    return {
      connect: async () => ({
        query: async (sql: string) => {
          queryLog.push(sql);
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked }] };
          return { rows: [] };
        },
        release: () => undefined,
      }),
    };
  }

  function sessionWithWatcher(polledMsAgo: number | null, enabled = true) {
    return mockSupabase({
      companies: { single: { data: { ai_globally_disabled: false }, error: null } },
      ai_capability_settings: { single: { data: { enabled }, error: null } },
      research_watcher_state: {
        data: polledMsAgo === null ? [] : [{ last_polled_at: iso(polledMsAgo) }],
      },
    });
  }

  beforeEach(() => {
    queryLog.length = 0;
    vi.mocked(pollAllWatchers).mockReset();
    vi.mocked(getIndustryBriefingPool).mockReset();
  });

  it("refuses plainly (403) when deep research is off, without polling", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionWithWatcher(null, false) as never);
    const res = await checkWires(
      new NextRequest("http://localhost/api/v1/research-briefings/check-wires", { method: "POST" }),
    );
    expect(res.status).toBe(403);
    expect(pollAllWatchers).not.toHaveBeenCalled();
  });

  it("cooldown: a poll 5 minutes ago means no new poll, with the wait stated", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionWithWatcher(5 * 60 * 1000) as never);
    const res = await checkWires(
      new NextRequest("http://localhost/api/v1/research-briefings/check-wires", { method: "POST" }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.state).toBe("cooldown");
    expect(body.next_check_in_minutes).toBe(25);
    expect(body.checked_at).toBe(iso(5 * 60 * 1000));
    expect(getIndustryBriefingPool).not.toHaveBeenCalled();
    expect(pollAllWatchers).not.toHaveBeenCalled();
  });

  it("busy: the tick holds the advisory lock, so the pull stands down", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionWithWatcher(2 * HOUR) as never);
    vi.mocked(getIndustryBriefingPool).mockReturnValue(fakePool(false) as never);
    const res = await checkWires(
      new NextRequest("http://localhost/api/v1/research-briefings/check-wires", { method: "POST" }),
    );
    const body = await res.json();
    expect(body.state).toBe("busy");
    expect(body.reason).toContain("mid-check");
    expect(pollAllWatchers).not.toHaveBeenCalled();
  });

  it("fresh: polls under the lock, reports the new signal count, unlocks", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionWithWatcher(2 * HOUR) as never);
    vi.mocked(getIndustryBriefingPool).mockReturnValue(fakePool(true) as never);
    vi.mocked(pollAllWatchers).mockResolvedValue([
      { watcherKey: "eia_diesel" },
      { watcherKey: "nws_weather" },
    ] as never);
    const res = await checkWires(
      new NextRequest("http://localhost/api/v1/research-briefings/check-wires", { method: "POST" }),
    );
    const body = await res.json();
    expect(body.state).toBe("fresh");
    expect(body.new_signals).toBe(2);
    expect(body.checked_at).not.toBeNull();
    expect(queryLog.some((sql) => sql.includes("pg_advisory_unlock"))).toBe(true);
  });

  it("quiet: a poll that finds nothing says so", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionWithWatcher(2 * HOUR) as never);
    vi.mocked(getIndustryBriefingPool).mockReturnValue(fakePool(true) as never);
    vi.mocked(pollAllWatchers).mockResolvedValue([] as never);
    const res = await checkWires(
      new NextRequest("http://localhost/api/v1/research-briefings/check-wires", { method: "POST" }),
    );
    const body = await res.json();
    expect(body.state).toBe("quiet");
    expect(body.new_signals).toBe(0);
  });

  it("unavailable: no job DB URL is a 200 with available:false, never a 500", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionWithWatcher(null) as never);
    vi.mocked(getIndustryBriefingPool).mockImplementation(() => {
      throw new Error("INDUSTRY_BRIEFING_DB_URL is not configured.");
    });
    const res = await checkWires(
      new NextRequest("http://localhost/api/v1/research-briefings/check-wires", { method: "POST" }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.state).toBe("unavailable");
    expect(body.available).toBe(false);
    expect(pollAllWatchers).not.toHaveBeenCalled();
  });
});
