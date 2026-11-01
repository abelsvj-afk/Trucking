import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/services/ai/run-industry-briefing";
import type { AiProvider } from "@/services/ai/provider";
import { getResearchConfig } from "@/services/research/config";
import {
  runResearchForCompany,
  runResearchJob,
} from "@/services/research/run-research";
import type { TelegramNotifier } from "@/services/telegram/notify";
import type { PressureSignal } from "@/services/research/watchers/types";

const config = getResearchConfig({} as NodeJS.ProcessEnv);
const NOW = new Date("2026-10-31T12:00:00Z");

const EIA_ITEM = {
  title: "EIA weekly diesel retail price - 2026-10-26",
  url: "https://www.eia.gov/petroleum/gasdiesel/",
  publishedAt: "2026-10-26",
  summary: "$5.890 per gallon",
};

const OK_OUTPUT = JSON.stringify({
  status: "ok",
  title: "Diesel spiked",
  headline: "Diesel jumped this week.",
  findings: [{ claim: "Diesel is $5.89/gal.", source_title: EIA_ITEM.title, source_url: EIA_ITEM.url }],
  what_changed: "Price moved up.",
  counter_move: "Fuel before the Georgia line.",
  takeaway: "Do this: check fuel prices before Sunday's run.",
  unverified: [],
  confidence: "high",
});

interface FakeDbOptions {
  eligible?: string[];
  history?: { last_baseline: string | null; runs_today: number; runs_month: number };
  queuedForCompany?: Array<{ id: string; company_id: string; topic: string }>;
  queuedGlobal?: Array<{ id: string; company_id: string; topic: string }>;
}

function fakeDb(options: FakeDbOptions = {}) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    if (text.includes("max(created_at)")) {
      return {
        rows: [
          options.history ?? { last_baseline: "2026-10-30T12:00:00Z", runs_today: 0, runs_month: 0 },
        ],
      };
    }
    if (text.includes("ai_capability_settings")) {
      return { rows: (options.eligible ?? []).map((company_id) => ({ company_id })) };
    }
    if (text.includes("company_id = $1") && text.includes("trigger_kind = 'manual'")) {
      return { rows: options.queuedForCompany ?? [] };
    }
    if (text.includes("trigger_kind = 'manual' and status = 'queued'")) {
      return { rows: options.queuedGlobal ?? [] };
    }
    if (text.includes("from research_signals")) {
      return {
        rows: [
          {
            watcher_key: "eia_diesel",
            kind: "fuel_price_observation",
            topic: "fuel",
            magnitude: 0.5,
            summary: "Diesel $5.890, up 5.00% week over week.",
            items: [EIA_ITEM],
            data: { wowPct: 5 },
            dedupe_key: "eia_diesel:2026-10-26",
            observed_at: "2026-10-31T00:00:00Z",
          },
        ],
      };
    }
    if (text.includes("insert into research_runs")) return { rows: [{ id: "run-1" }] };
    if (text.includes("insert into research_briefings")) return { rows: [{ id: "brief-1" }] };
    return { rows: [] };
  });
  return { db: { query } as unknown as Queryable, calls };
}

function providerReturning(raw: string) {
  return { complete: vi.fn().mockResolvedValue(raw) } as unknown as AiProvider;
}

const notifier: TelegramNotifier = { notifyOwner: vi.fn().mockResolvedValue(true) };

function dieselSignal(wowPct: number): PressureSignal {
  return {
    watcherKey: "eia_diesel",
    kind: "fuel_price_observation",
    topic: "fuel",
    magnitude: 0.5,
    summary: "diesel moved",
    items: [EIA_ITEM],
    data: { wowPct },
    dedupeKey: "eia_diesel:2026-10-26",
    observedAt: NOW.toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("kill switch (runResearchJob eligibility)", () => {
  it("never calls the provider for a company whose capability is off, and closes its queued manual run as skipped_disabled", async () => {
    const provider = providerReturning(OK_OUTPUT);
    const { db, calls } = fakeDb({
      eligible: [],
      queuedGlobal: [{ id: "q1", company_id: "company-off", topic: "factoring" }],
    });

    await runResearchJob(db, provider, notifier, [], config);

    expect(provider.complete).not.toHaveBeenCalled();
    const skip = calls.find((c) => c.text.includes("update research_runs") && c.params?.includes("skipped_disabled"));
    expect(skip?.params).toContain("q1");
    expect(calls.some((c) => c.text.includes("insert into research_briefings"))).toBe(false);
  });
});

describe("run caps (runResearchForCompany)", () => {
  it("logs skipped_cap and does not call the provider when the daily cap is spent", async () => {
    const provider = providerReturning(OK_OUTPUT);
    const { db, calls } = fakeDb({
      history: { last_baseline: "2026-10-30T12:00:00Z", runs_today: 2, runs_month: 2 },
    });

    const summary = await runResearchForCompany(db, provider, notifier, "company-1", [dieselSignal(5)], config, NOW);

    expect(summary).toEqual({ executed: 0, skippedCap: 1, skippedDisabled: 0 });
    expect(provider.complete).not.toHaveBeenCalled();
    const skipInsert = calls.find(
      (c) => c.text.includes("insert into research_runs") && c.params?.includes("skipped_cap"),
    );
    expect(skipInsert?.params?.join(" ")).toContain("Run cap reached");
  });
});

describe("run execution", () => {
  it("stores a grounded briefing, marks the run success, and notifies on Telegram", async () => {
    const provider = providerReturning(OK_OUTPUT);
    const { db, calls } = fakeDb({
      history: { last_baseline: null, runs_today: 0, runs_month: 0 },
    });

    const summary = await runResearchForCompany(db, provider, notifier, "company-1", [], config, NOW);

    expect(summary.executed).toBe(1);
    const briefingInsert = calls.find((c) => c.text.includes("insert into research_briefings"));
    expect(briefingInsert?.params).toContain("Diesel spiked");
    expect(briefingInsert?.params).toContain("Fuel before the Georgia line.");
    const success = calls.find((c) => c.text.includes("set status = 'success'"));
    expect(success?.params).toContain("brief-1");
    expect(notifier.notifyOwner).toHaveBeenCalledWith(expect.stringContaining("Diesel spiked"));
    expect(calls.some((c) => c.text.includes("telegram_notified_at"))).toBe(true);
  });

  it("executes a queued manual run by claiming its existing row", async () => {
    const provider = providerReturning(OK_OUTPUT);
    const { db, calls } = fakeDb({
      history: { last_baseline: "2026-10-30T12:00:00Z", runs_today: 0, runs_month: 0 },
      queuedForCompany: [{ id: "q9", company_id: "company-1", topic: "factoring" }],
    });

    const summary = await runResearchForCompany(db, provider, notifier, "company-1", [], config, NOW);

    expect(summary.executed).toBe(1);
    const claim = calls.find((c) => c.text.includes("status = 'running'"));
    expect(claim?.params).toContain("q9");
    // The manual run must not also insert a fresh run row for itself.
    expect(calls.some((c) => c.text.includes("insert into research_runs"))).toBe(false);
  });

  it("records insufficient_data without storing a briefing", async () => {
    const provider = providerReturning(
      JSON.stringify({ status: "insufficient_data", reason: "Only one thin signal this cycle." }),
    );
    const { db, calls } = fakeDb({ history: { last_baseline: null, runs_today: 0, runs_month: 0 } });

    await runResearchForCompany(db, provider, notifier, "company-1", [], config, NOW);

    expect(calls.some((c) => c.text.includes("insert into research_briefings"))).toBe(false);
    const runUpdate = calls.find((c) => c.text.includes("set status = 'insufficient_data'"));
    expect(runUpdate?.params).toContain("Only one thin signal this cycle.");
    expect(notifier.notifyOwner).not.toHaveBeenCalled();
  });

  it("fails the run loudly when the AI cites a source outside the evidence", async () => {
    const provider = providerReturning(
      JSON.stringify({
        status: "ok",
        title: "Invented",
        headline: "h",
        findings: [{ claim: "c", source_title: "Nowhere", source_url: "https://evil.example/x" }],
        what_changed: "w",
        counter_move: "c",
        takeaway: "t",
        unverified: [],
        confidence: "low",
      }),
    );
    const { db, calls } = fakeDb({ history: { last_baseline: null, runs_today: 0, runs_month: 0 } });

    await runResearchForCompany(db, provider, notifier, "company-1", [], config, NOW);

    expect(calls.some((c) => c.text.includes("insert into research_briefings"))).toBe(false);
    const failure = calls.find((c) => c.text.includes("set status = 'failure'"));
    expect(failure?.params?.join(" ")).toContain("not present in the run's evidence");
  });
});
