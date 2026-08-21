import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/integrations", () => ({
  gatherIndustrySources: vi.fn(),
  SourceUnreachableError: class SourceUnreachableError extends Error {},
}));
vi.mock("@/services/ai/industry-briefing", () => ({
  generateIndustryBriefing: vi.fn(),
}));

import { gatherIndustrySources } from "@/services/integrations";
import { generateIndustryBriefing } from "@/services/ai/industry-briefing";
import {
  runIndustryBriefingForCompany,
  runIndustryBriefingJob,
  type Queryable,
} from "@/services/ai/run-industry-briefing";
import type { AiProvider } from "@/services/ai/provider";

function mockDb(queryImpl?: (text: string, params?: unknown[]) => unknown): Queryable {
  const query = vi.fn().mockImplementation(async (text: string, params?: unknown[]) => {
    if (queryImpl) return queryImpl(text, params) ?? { rows: [] };
    return { rows: [] };
  });
  return { query } as unknown as Queryable;
}

const NOOP_PROVIDER: AiProvider = { complete: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runIndustryBriefingForCompany", () => {
  it("inserts a briefing + a success run on an 'ok' result", async () => {
    vi.mocked(gatherIndustrySources).mockResolvedValue({} as never);
    vi.mocked(generateIndustryBriefing).mockResolvedValue({
      status: "ok",
      summary: "s",
      reasoning: "r",
      confidence: "high",
      based_on: ["EIA"],
    });

    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const db = mockDb((text, params) => {
      calls.push({ text, params });
      if (text.includes("insert into industry_briefings")) return { rows: [{ id: "briefing-1" }] };
      return { rows: [] };
    });

    await runIndustryBriefingForCompany(db, NOOP_PROVIDER, "company-1");

    expect(calls.some((c) => c.text.includes("insert into industry_briefings"))).toBe(true);
    const runInsert = calls.find((c) => c.text.includes("insert into industry_briefing_runs"));
    expect(runInsert?.text).toContain("'success'");
    expect(runInsert?.params).toContain("briefing-1");
  });

  it("inserts only a run (status insufficient_data) on an 'insufficient_data' result, no briefing", async () => {
    vi.mocked(gatherIndustrySources).mockResolvedValue({} as never);
    vi.mocked(generateIndustryBriefing).mockResolvedValue({
      status: "insufficient_data",
      reason: "nothing notable this cycle",
    });

    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const db = mockDb((text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    });

    await runIndustryBriefingForCompany(db, NOOP_PROVIDER, "company-1");

    expect(calls.some((c) => c.text.includes("insert into industry_briefings"))).toBe(false);
    const runInsert = calls.find((c) => c.text.includes("insert into industry_briefing_runs"));
    expect(runInsert?.text).toContain("insufficient_data");
    expect(runInsert?.params).toContain("nothing notable this cycle");
  });

  it("inserts a failure run and does not throw when a source is unreachable", async () => {
    vi.mocked(gatherIndustrySources).mockRejectedValue(new Error("EIA unreachable"));

    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const db = mockDb((text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    });

    await expect(runIndustryBriefingForCompany(db, NOOP_PROVIDER, "company-1")).resolves.toBeUndefined();

    const runInsert = calls.find((c) => c.text.includes("insert into industry_briefing_runs"));
    expect(runInsert?.text).toContain("'failure'");
    expect(runInsert?.params).toContain("EIA unreachable");
  });
});

describe("runIndustryBriefingJob", () => {
  it("only runs companies returned as eligible by the database", async () => {
    vi.mocked(gatherIndustrySources).mockResolvedValue({} as never);
    vi.mocked(generateIndustryBriefing).mockResolvedValue({
      status: "insufficient_data",
      reason: "x",
    });

    const ranFor: string[] = [];
    const db = mockDb((text, params) => {
      if (text.includes("from companies")) return { rows: [{ company_id: "company-1" }, { company_id: "company-2" }] };
      if (text.includes("insert into industry_briefing_runs")) {
        ranFor.push((params as unknown[])[0] as string);
      }
      return { rows: [] };
    });

    await runIndustryBriefingJob(db, NOOP_PROVIDER, 1000);

    expect(ranFor).toEqual(["company-1", "company-2"]);
  });

  it("does nothing when no company is eligible", async () => {
    const db = mockDb((text) => (text.includes("from companies") ? { rows: [] } : { rows: [] }));
    await runIndustryBriefingJob(db, NOOP_PROVIDER, 1000);
    expect(gatherIndustrySources).not.toHaveBeenCalled();
  });
});
