import { describe, expect, it, vi } from "vitest";
import { generateIndustryBriefing } from "@/services/ai/industry-briefing";
import type { AiProvider } from "@/services/ai/provider";
import type { IndustrySources } from "@/services/integrations";

const SOURCES: IndustrySources = {
  fuelMarket: { label: "U.S. average diesel", period: "2026-08-18", pricePerGallon: 3.85, units: "$/GAL" },
  news: [
    {
      source: "FMCSA Newsroom",
      items: [
        { source: "FMCSA Newsroom", title: "New ELD rule", link: "https://x.test/1", publishedAt: null, summary: "Summary" },
      ],
      error: null,
    },
  ],
  newsPartial: false,
};

describe("generateIndustryBriefing", () => {
  it("passes fuel and news context to the provider and parses its response", async () => {
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        status: "ok",
        summary: "s",
        reasoning: "r",
        confidence: "medium",
        based_on: ["FMCSA Newsroom"],
      }),
    );
    const provider: AiProvider = { complete };

    const result = await generateIndustryBriefing(provider, SOURCES);

    expect(result.status).toBe("ok");
    const call = complete.mock.calls[0]?.[0];
    expect(call.system).toContain("Never recommend a specific business action");
    expect(call.user).toContain("3.85 $/GAL");
    expect(call.user).toContain("New ELD rule");
  });

  it("propagates a parse failure when the provider returns invalid output", async () => {
    const provider: AiProvider = { complete: vi.fn().mockResolvedValue("not json") };
    await expect(generateIndustryBriefing(provider, SOURCES)).rejects.toThrow("not valid JSON");
  });

  it("notes partial news coverage in the prompt when newsPartial is true", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ status: "insufficient_data", reason: "thin" }));
    const provider: AiProvider = { complete };

    await generateIndustryBriefing(provider, { ...SOURCES, newsPartial: true });

    const call = complete.mock.calls[0]?.[0];
    expect(call.user).toContain("coverage is partial");
  });

  it("rejects a based_on citation that doesn't match anything in the actual context", async () => {
    const provider: AiProvider = {
      complete: vi.fn().mockResolvedValue(
        JSON.stringify({
          status: "ok",
          summary: "s",
          reasoning: "r",
          confidence: "high",
          based_on: ["Reuters exclusive report"],
        }),
      ),
    };

    await expect(generateIndustryBriefing(provider, SOURCES)).rejects.toThrow(
      "cited source(s) not present in the provided context",
    );
  });

  it("accepts a based_on citation matching the fuel snapshot's label", async () => {
    const provider: AiProvider = {
      complete: vi.fn().mockResolvedValue(
        JSON.stringify({
          status: "ok",
          summary: "s",
          reasoning: "r",
          confidence: "high",
          based_on: ["U.S. average diesel"],
        }),
      ),
    };

    const result = await generateIndustryBriefing(provider, SOURCES);
    expect(result.status).toBe("ok");
  });

  it("also validates based_on inside each option, not just the top level", async () => {
    const provider: AiProvider = {
      complete: vi.fn().mockResolvedValue(
        JSON.stringify({
          status: "ok",
          summary: "s",
          reasoning: "r",
          confidence: "high",
          based_on: ["FMCSA Newsroom"],
          options: [
            { summary: "s2", reasoning: "r2", confidence: "low", based_on: ["a source that was never given"] },
          ],
        }),
      ),
    };

    await expect(generateIndustryBriefing(provider, SOURCES)).rejects.toThrow(
      "cited source(s) not present in the provided context",
    );
  });
});
