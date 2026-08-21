import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/db/industry-briefing-pool", () => ({
  getIndustryBriefingPool: vi.fn().mockReturnValue({}),
}));
vi.mock("@/services/ai/providers/openai", () => ({
  OpenAiProvider: class {},
}));
vi.mock("@/services/ai/run-industry-briefing", () => ({
  runIndustryBriefingJob: vi.fn(),
}));

import { runIndustryBriefingJob } from "@/services/ai/run-industry-briefing";
import { POST } from "@/app/api/internal/industry-briefing/run/route";

const originalSecret = process.env.INDUSTRY_BRIEFING_CRON_SECRET;

beforeEach(() => {
  process.env.INDUSTRY_BRIEFING_CRON_SECRET = "correct-secret";
  vi.mocked(runIndustryBriefingJob).mockReset();
});

afterAll(() => {
  process.env.INDUSTRY_BRIEFING_CRON_SECRET = originalSecret;
});

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/internal/industry-briefing/run", {
    method: "POST",
    headers,
  });
}

describe("POST /api/internal/industry-briefing/run", () => {
  it("401s when no secret header is provided", async () => {
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(runIndustryBriefingJob).not.toHaveBeenCalled();
  });

  it("401s when the wrong secret is provided", async () => {
    const res = await POST(request({ "x-industry-briefing-secret": "wrong" }));
    expect(res.status).toBe(401);
  });

  it("401s when INDUSTRY_BRIEFING_CRON_SECRET isn't configured (fails closed)", async () => {
    delete process.env.INDUSTRY_BRIEFING_CRON_SECRET;
    const res = await POST(request({ "x-industry-briefing-secret": "anything" }));
    expect(res.status).toBe(401);
  });

  it("runs the job and returns ok with the correct secret", async () => {
    vi.mocked(runIndustryBriefingJob).mockResolvedValue(undefined);
    const res = await POST(request({ "x-industry-briefing-secret": "correct-secret" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(runIndustryBriefingJob).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0);
  });

  it("500s without leaking detail when the job throws", async () => {
    vi.mocked(runIndustryBriefingJob).mockRejectedValue(new Error("db exploded"));
    const res = await POST(request({ "x-industry-briefing-secret": "correct-secret" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).not.toContain("db exploded");
  });
});
