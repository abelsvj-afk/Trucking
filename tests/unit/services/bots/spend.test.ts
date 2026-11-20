// Model tiers + hard spending cap. The ledger tracks ESTIMATES, not
// bills — the cap trips early on purpose.
import { describe, expect, it } from "vitest";
import {
  estimateCallCostCents,
  estimateTokens,
  modelForTier,
  monthlyCapCents,
  monthStartIso,
  rankModel,
  scanModel,
} from "@/services/bots/spend";

describe("bot spend cap", () => {
  it("defaults the monthly cap to $10 — one top-up", () => {
    expect(monthlyCapCents({})).toBe(1000);
    expect(monthlyCapCents({ BOT_MONTHLY_SPEND_CAP_CENTS: "2500" })).toBe(2500);
    expect(monthlyCapCents({ BOT_MONTHLY_SPEND_CAP_CENTS: "junk" })).toBe(1000);
  });

  it("estimates tokens at ~4 chars each", () => {
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(0)).toBe(1);
  });

  it("charges a minimum of 1 cent per call and ranks cost more than scans", () => {
    expect(estimateCallCostCents({ tier: "scan", inputChars: 400, outputChars: 40 })).toBe(1);
    const scan = estimateCallCostCents({ tier: "scan", inputChars: 400000, outputChars: 40000 });
    const rank = estimateCallCostCents({ tier: "rank", inputChars: 400000, outputChars: 40000 });
    expect(scan).toBeGreaterThan(1);
    expect(rank).toBeGreaterThan(scan);
  });



  it("defaults both tiers to the scan model — no model name invented", () => {
    expect(scanModel({})).toBe("gpt-4o-mini");
    expect(rankModel({})).toBe("gpt-4o-mini");
    expect(modelForTier("rank", { BOT_RANK_MODEL: "gpt-4o" })).toBe("gpt-4o");
    expect(modelForTier("scan", { OPENAI_MODEL: "gpt-4o-mini" })).toBe("gpt-4o-mini");
  });

  it("starts the month on the 1st", () => {
    expect(monthStartIso(new Date("2026-11-19T12:00:00Z"))).toBe("2026-11-01T00:00:00.000Z");
  });
});
