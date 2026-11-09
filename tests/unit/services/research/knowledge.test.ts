// Knowledge layer (docs/design/autonomous-research.md §3) against a
// substring-matching fake Queryable: distillation stores one
// company-scoped row per fresh signal with source + date, dedupe is
// the table's conflict clause, the own-business snapshot assembles
// from the company's own records, and a pre-00084 database degrades
// to a logged skip instead of an error.

import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/services/ai/run-industry-briefing";
import {
  distillSignalsToKnowledge,
  loadLatestKnowledgeByTopic,
  refreshBusinessKnowledge,
} from "@/services/research/knowledge";
import type { PressureSignal } from "@/services/research/watchers/types";

const COMPANY = "company-1";

function signal(overrides: Partial<PressureSignal> = {}): PressureSignal {
  return {
    watcherKey: "eia_diesel",
    kind: "fuel_price_observation",
    topic: "fuel",
    magnitude: 0.4,
    summary: "U.S. average diesel retail price: $3.997/gal, up 1.20% week over week.",
    items: [
      {
        title: "EIA weekly diesel retail price - 2026-11-09",
        url: "https://www.eia.gov/petroleum/gasdiesel/",
        publishedAt: "2026-11-09",
        summary: "$3.997 per gallon",
      },
    ],
    data: {},
    dedupeKey: "eia_diesel:2026-11-09",
    observedAt: "2026-11-09T12:00:00Z",
    ...overrides,
  };
}

interface FakeOptions {
  missingKnowledgeTable?: boolean;
  business?: {
    aggregate?: Record<string, unknown>;
    expenses?: number;
    lanes?: Array<Record<string, unknown>>;
    profile?: Record<string, unknown> | null;
  };
}

function fakeDb(options: FakeOptions = {}) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    if (text.includes("insert into research_knowledge")) {
      if (options.missingKnowledgeTable) {
        throw new Error('relation "research_knowledge" does not exist');
      }
      return { rows: [{ id: "k-1" }] };
    }
    if (text.includes("from loads") && text.includes("count(*)::int as loads_in_window")) {
      return {
        rows: [
          options.business?.aggregate ?? {
            loads_in_window: 0,
            loads_completed: 0,
            total_miles: 0,
            revenue_cents: null,
            revenue_loads: 0,
          },
        ],
      };
    }
    if (text.includes("from expenses")) {
      return { rows: [{ expense_cents: options.business?.expenses ?? 0 }] };
    }
    if (text.includes("group by origin, destination")) {
      return { rows: options.business?.lanes ?? [] };
    }
    if (text.includes("from employer_pay_profiles")) {
      return { rows: options.business?.profile ? [options.business.profile] : [] };
    }
    if (text.includes("distinct on (watch_topic)")) {
      return {
        rows: [
          {
            watch_topic: "industry",
            title: "EIA weekly diesel",
            content: "Diesel $3.997/gal.",
            source_title: "EIA",
            source_url: "https://www.eia.gov/",
            observed_at: "2026-11-09T12:00:00Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  return { db: { query } as unknown as Queryable, calls };
}

describe("distillSignalsToKnowledge", () => {
  it("stores one company-scoped row per signal with source and date", async () => {
    const { db, calls } = fakeDb();
    const stored = await distillSignalsToKnowledge(db, COMPANY, [signal()]);
    expect(stored).toBe(1);
    const insert = calls.find((c) => c.text.includes("insert into research_knowledge"));
    expect(insert).toBeDefined();
    expect(insert!.params?.[0]).toBe(COMPANY);
    expect(insert!.params?.[1]).toBe("industry");
    expect(insert!.params?.[5]).toBe("https://www.eia.gov/petroleum/gasdiesel/");
    expect(insert!.text).toContain("on conflict (company_id, dedupe_key) do nothing");
  });

  it("files the crypto snapshot under crypto, not industry", async () => {
    const { db, calls } = fakeDb();
    await distillSignalsToKnowledge(db, COMPANY, [
      signal({ watcherKey: "coingecko_crypto", topic: "crypto", dedupeKey: "crypto_snapshot:2026-11-09" }),
    ]);
    const insert = calls.find((c) => c.text.includes("insert into research_knowledge"));
    expect(insert!.params?.[1]).toBe("crypto");
  });

  it("degrades to a skip when migration 00084 is not applied", async () => {
    const { db } = fakeDb({ missingKnowledgeTable: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(distillSignalsToKnowledge(db, COMPANY, [signal()])).resolves.toBe(0);
    spy.mockRestore();
  });
});

describe("refreshBusinessKnowledge", () => {
  it("assembles the snapshot from his own records and upserts today's row", async () => {
    const { db, calls } = fakeDb({
      business: {
        aggregate: { loads_in_window: 3, loads_completed: 1, total_miles: 2400, revenue_cents: 300000, revenue_loads: 3 },
        expenses: 25000,
        lanes: [{ origin: "Panama City, FL", destination: "Seminole, OK", lane_count: 2 }],
        profile: { rate_cents_per_mile: 55, mile_basis: null },
      },
    });
    const written = await refreshBusinessKnowledge(db, COMPANY, new Date("2026-11-09T17:00:00Z"));
    expect(written).toBe(true);
    const upsert = calls.find((c) => c.text.includes("insert into research_knowledge"));
    expect(upsert).toBeDefined();
    const content = String(upsert!.params?.[2]);
    expect(content).toContain("3 loads");
    expect(content).toContain("UNSET");
    expect(String(upsert!.params?.[4])).toBe("business_snapshot:2026-11-09");
  });

  it("writes nothing when there is nothing to say", async () => {
    const { db, calls } = fakeDb();
    const written = await refreshBusinessKnowledge(db, COMPANY, new Date("2026-11-09T17:00:00Z"));
    expect(written).toBe(false);
    expect(calls.some((c) => c.text.includes("insert into research_knowledge"))).toBe(false);
  });
});

describe("loadLatestKnowledgeByTopic", () => {
  it("maps rows by standing topic", async () => {
    const { db } = fakeDb();
    const latest = await loadLatestKnowledgeByTopic(db, COMPANY);
    expect(latest.industry?.title).toBe("EIA weekly diesel");
    expect(latest.crypto).toBeUndefined();
  });
});
