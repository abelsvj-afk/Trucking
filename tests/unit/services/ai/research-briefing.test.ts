import { describe, expect, it, vi } from "vitest";
import { generateResearchBriefing, type ResearchBriefingContext } from "@/services/ai/research-briefing";
import type { AiProvider } from "@/services/ai/provider";

const CONTEXT: ResearchBriefingContext = {
  topic: "fuel",
  triggerReason: "Diesel moved 5% week over week.",
  items: [
    {
      title: "EIA weekly diesel retail price - 2026-10-26",
      url: "https://www.eia.gov/petroleum/gasdiesel/",
      publishedAt: "2026-10-26",
      summary: "$5.890 per gallon",
    },
  ],
  signalSummaries: ["Diesel $5.890, up 5.00% week over week."],
};

function providerReturning(raw: string): AiProvider {
  return { complete: vi.fn().mockResolvedValue(raw) };
}

const OK = {
  status: "ok",
  title: "Diesel spiked",
  headline: "Diesel jumped 5% in a week.",
  findings: [
    {
      claim: "Diesel is $5.89/gal.",
      source_title: "EIA weekly diesel retail price - 2026-10-26",
      source_url: "https://www.eia.gov/petroleum/gasdiesel/",
    },
  ],
  what_changed: "Price moved.",
  counter_move: "Compare corridor prices before Sunday.",
  takeaway: "Do this: check the EIA number every Monday.",
  unverified: ["A rumor about a refinery outage."],
  confidence: "medium",
};

describe("generateResearchBriefing", () => {
  it("returns a validated briefing whose findings cite the evidence", async () => {
    const output = await generateResearchBriefing(providerReturning(JSON.stringify(OK)), CONTEXT);
    expect(output.status).toBe("ok");
    if (output.status === "ok") {
      expect(output.findings).toHaveLength(1);
      expect(output.unverified).toEqual(["A rumor about a refinery outage."]);
      expect(output.takeaway).toContain("Do this");
    }
  });

  it("passes through insufficient_data", async () => {
    const output = await generateResearchBriefing(
      providerReturning(JSON.stringify({ status: "insufficient_data", reason: "thin" })),
      CONTEXT,
    );
    expect(output).toEqual({ status: "insufficient_data", reason: "thin" });
  });

  it("rejects a finding whose URL is not in the evidence (no sources, no briefing)", async () => {
    const invented = {
      ...OK,
      findings: [{ claim: "x", source_title: "EIA weekly diesel retail price - 2026-10-26", source_url: "https://example.com/fake" }],
    };
    await expect(generateResearchBriefing(providerReturning(JSON.stringify(invented)), CONTEXT)).rejects.toThrow(
      "not present in the run's evidence",
    );
  });

  it("rejects malformed output instead of trusting its shape", async () => {
    await expect(generateResearchBriefing(providerReturning("not json"), CONTEXT)).rejects.toThrow(
      "not valid JSON",
    );
    await expect(
      generateResearchBriefing(providerReturning(JSON.stringify({ status: "ok", title: "x" })), CONTEXT),
    ).rejects.toThrow("didn't match the research-briefing contract");
  });
});
