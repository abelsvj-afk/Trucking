import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/services/ai/run-industry-briefing";
import { getResearchConfig } from "@/services/research/config";
import { detectHealthIssues, evaluateResearchHealth } from "@/services/research/health";
import type { TelegramNotifier } from "@/services/telegram/notify";

const config = getResearchConfig({} as NodeJS.ProcessEnv);
const NOW = new Date("2026-10-31T12:00:00Z");
const HOUR = 3600 * 1000;

interface FakeOptions {
  lastTickAt?: string | null;
  watchers?: Array<{ watcher_key: string; last_status: string; last_error: string | null; updated_at: string }>;
  eligible?: string[];
  lastSuccess?: string | null;
}

function fakeDb(options: FakeOptions = {}) {
  const alerts = new Map<string, { issue_key: string; last_alerted_at: string | null; active: boolean }>();
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes("research_runner_heartbeat")) {
      return { rows: options.lastTickAt === undefined ? [] : [{ last_tick_at: options.lastTickAt }] };
    }
    if (text.includes("research_watcher_state")) return { rows: options.watchers ?? [] };
    if (text.includes("ai_capability_settings")) {
      return { rows: (options.eligible ?? []).map((company_id) => ({ company_id })) };
    }
    if (text.includes("last_success")) return { rows: [{ last_success: options.lastSuccess ?? null }] };
    if (text.includes("from research_health_alerts") && text.includes("where issue_key = $1")) {
      const row = alerts.get(String(params?.[0]));
      return { rows: row ? [row] : [] };
    }
    if (text.includes("from research_health_alerts") && text.includes("active = true")) {
      return { rows: [...alerts.values()].filter((a) => a.active) };
    }
    if (text.includes("insert into research_health_alerts")) {
      const key = String(params?.[0]);
      const prev = alerts.get(key);
      alerts.set(key, { issue_key: key, last_alerted_at: prev?.last_alerted_at ?? null, active: true });
      return { rows: [] };
    }
    if (text.includes("set last_alerted_at = now()")) {
      const row = alerts.get(String(params?.[0]));
      if (row) row.last_alerted_at = NOW.toISOString();
      return { rows: [] };
    }
    if (text.includes("set active = false")) {
      const row = alerts.get(String(params?.[0]));
      if (row) row.active = false;
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { db: { query } as unknown as Queryable, alerts };
}

function notifier() {
  return { notifyOwner: vi.fn(async () => true) } as unknown as TelegramNotifier & { notifyOwner: ReturnType<typeof vi.fn> };
}

describe("detectHealthIssues", () => {
  it("flags a runner that never ticked, and one gone stale", async () => {
    const never = await detectHealthIssues(fakeDb({ lastTickAt: null }).db, config, NOW);
    expect(never.map((i) => i.key)).toContain("runner_never_ticked");

    const stale = await detectHealthIssues(
      fakeDb({ lastTickAt: new Date(NOW.getTime() - 30 * HOUR).toISOString() }).db,
      config,
      NOW,
    );
    expect(stale.map((i) => i.key)).toContain("runner_stale");

    const fresh = await detectHealthIssues(
      fakeDb({ lastTickAt: new Date(NOW.getTime() - 2 * HOUR).toISOString() }).db,
      config,
      NOW,
    );
    expect(fresh).toEqual([]);
  });

  it("flags a missing EIA key, a watcher stuck in error, and a broken floor", async () => {
    const issues = await detectHealthIssues(
      fakeDb({
        lastTickAt: NOW.toISOString(),
        watchers: [
          { watcher_key: "eia_diesel", last_status: "skipped", last_error: "no key", updated_at: NOW.toISOString() },
          {
            watcher_key: "federal_register",
            last_status: "error",
            last_error: "boom",
            updated_at: new Date(NOW.getTime() - 30 * HOUR).toISOString(),
          },
        ],
        eligible: ["company-1"],
        lastSuccess: null,
      }).db,
      config,
      NOW,
    );
    const keys = issues.map((i) => i.key);
    expect(keys).toContain("eia_key_missing");
    expect(keys).toContain("watcher_error:federal_register");
    expect(keys).toContain("floor:company-1");
  });
});

describe("evaluateResearchHealth", () => {
  it("alerts once, throttles the repeat within 24h, and reports recovery when the issue clears", async () => {
    const staleDb = fakeDb({ lastTickAt: new Date(NOW.getTime() - 30 * HOUR).toISOString() });
    const owner = notifier();

    const first = await evaluateResearchHealth(staleDb.db, owner, config, NOW);
    expect(first.alertsSent).toContain("runner_stale");
    expect(owner.notifyOwner).toHaveBeenCalledTimes(1);

    const second = await evaluateResearchHealth(staleDb.db, owner, config, NOW);
    expect(second.alertsSent).toEqual([]);
    expect(owner.notifyOwner).toHaveBeenCalledTimes(1); // throttled

    // A later tick with a fresh heartbeat and the same alert state:
    // the issue has cleared, so it recovers exactly once.
    const shared = fakeDb({ lastTickAt: NOW.toISOString() });
    shared.alerts.set("runner_stale", { issue_key: "runner_stale", last_alerted_at: NOW.toISOString(), active: true });
    const third = await evaluateResearchHealth(shared.db, owner, config, NOW);
    expect(third.recovered).toContain("runner_stale");
    expect(owner.notifyOwner).toHaveBeenCalledWith(expect.stringContaining("recovered"));
  });

  it("never throws, even when the database is down", async () => {
    const down = { query: vi.fn(async () => { throw new Error("connection refused"); }) } as unknown as Queryable;
    const summary = await evaluateResearchHealth(down, notifier(), config, NOW);
    expect(summary).toEqual({ alertsSent: [], recovered: [] });
  });
});
