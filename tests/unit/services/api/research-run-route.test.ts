import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/research/scheduler", () => ({
  runResearchTick: vi.fn(),
}));

import { runResearchTick } from "@/services/research/scheduler";
import { POST } from "@/app/api/internal/research/run/route";

const originalSecret = process.env.RESEARCH_RUN_CRON_SECRET;

beforeEach(() => {
  process.env.RESEARCH_RUN_CRON_SECRET = "correct-secret";
  vi.mocked(runResearchTick).mockReset();
});

afterAll(() => {
  process.env.RESEARCH_RUN_CRON_SECRET = originalSecret;
});

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/internal/research/run", {
    method: "POST",
    headers,
  });
}

describe("POST /api/internal/research/run", () => {
  it("401s when no secret header is provided", async () => {
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(runResearchTick).not.toHaveBeenCalled();
  });

  it("401s when the wrong secret is provided", async () => {
    const res = await POST(request({ "x-research-secret": "wrong" }));
    expect(res.status).toBe(401);
    expect(runResearchTick).not.toHaveBeenCalled();
  });

  it("401s when RESEARCH_RUN_CRON_SECRET isn't configured (fails closed)", async () => {
    delete process.env.RESEARCH_RUN_CRON_SECRET;
    const res = await POST(request({ "x-research-secret": "anything" }));
    expect(res.status).toBe(401);
  });

  it("runs the tick as source 'endpoint' and returns its summary with the correct secret", async () => {
    vi.mocked(runResearchTick).mockResolvedValue({ source: "endpoint", locked: false, freshSignals: 3, health: null });
    const res = await POST(request({ "x-research-secret": "correct-secret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.tick.freshSignals).toBe(3);
    expect(runResearchTick).toHaveBeenCalledWith("endpoint");
  });

  it("surfaces a degraded status when the tick reports an explicit health failure (CD-7)", async () => {
    vi.mocked(runResearchTick).mockResolvedValue({
      source: "endpoint",
      locked: false,
      freshSignals: 0,
      health: {
        alertsSent: ["runner_config_missing"],
        recovered: [],
        failure: "The research runner cannot start: INDUSTRY_BRIEFING_DB_URL is not configured.",
      },
    });
    const res = await POST(request({ "x-research-secret": "correct-secret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.tick.health.failure).toContain("INDUSTRY_BRIEFING_DB_URL");
  });

  it("500s without leaking detail if the tick itself throws", async () => {
    vi.mocked(runResearchTick).mockRejectedValue(new Error("db exploded"));
    const res = await POST(request({ "x-research-secret": "correct-secret" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).not.toContain("db exploded");
  });
});
