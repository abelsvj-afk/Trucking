// Phase E acceptance (design §6/§7 Phase E): the twin's code -
// edit distance between draft and sent (word-level, normalized),
// exemplar ranking that only ever learns from ACTUAL sent replies,
// the digest line's honest bands, and the transcription provider
// resolution (free-first: Groq free tier / custom endpoint win
// over the paid default; no keys anywhere = not configured).

import { describe, expect, it } from "vitest";
import {
  editDistanceRatio,
  formatExemplarsBlock,
  formatTwinDigestLine,
  rankExemplars,
} from "@/services/bot/voice-corpus";
import { isTranscriptionConfigured, transcriptionConfig } from "@/services/ai/transcription";

describe("editDistanceRatio", () => {
  it("0 for identical, 1 for nothing shared, in between for partial edits", () => {
    expect(editDistanceRatio("Sounds good, see you at 6", "Sounds good, see you at 6")).toBe(0);
    expect(editDistanceRatio("alpha beta gamma", "delta epsilon zeta")).toBe(1);
    // one word changed of six -> 1/6
    expect(editDistanceRatio("I will be there at six", "I will be there at seven")).toBeCloseTo(1 / 6);
    // case and spacing don't count as edits
    expect(editDistanceRatio("OK  copy   that", "ok copy that")).toBe(0);
    expect(editDistanceRatio("", "")).toBe(0);
    expect(editDistanceRatio("something", "")).toBe(1);
  });
});

describe("rankExemplars", () => {
  const candidates = [
    { id: "e1", incoming: "Can you confirm the Dallas pickup at 8am tomorrow?", actualReply: "Copy, I'll be there at 8" },
    { id: "e2", incoming: "Dallas pickup moved - confirm new time?", actualReply: null }, // draft only - NEVER an exemplar
    { id: "e3", incoming: "What is the detention policy at the Memphis warehouse?", actualReply: "Two hours free then it bills" },
    { id: "e4", incoming: "Confirming Dallas delivery appointment Friday", actualReply: "Confirmed for Friday" },
  ];

  it("returns only exchanges with an actual sent reply, most similar first", () => {
    const ranked = rankExemplars("Please confirm the Dallas pickup tomorrow morning", candidates);
    expect(ranked.map((r) => r.exchangeId)).toEqual(["e1", "e4"]);
    expect(ranked[0]?.actualReply).toContain("I'll be there at 8");
  });

  it("no shared content words -> no exemplars (an empty block beats a wrong one)", () => {
    expect(rankExemplars("zumba quantum spaghetti", candidates)).toEqual([]);
  });
});

describe("formatExemplarsBlock / formatTwinDigestLine", () => {
  it("quotes HIS words as his; empty in, null out", () => {
    expect(formatExemplarsBlock([])).toBeNull();
    const block = formatExemplarsBlock([
      { exchangeId: "e1", incoming: "ETA?", actualReply: "Rolling, 40 out" },
    ]);
    expect(block).toContain("HOW HE ACTUALLY WRITES");
    expect(block).toContain("Rolling, 40 out");
  });

  it("digest line: honest bands, and silence when there is nothing measured", () => {
    expect(formatTwinDigestLine({ count: 0, avgDistance: null })).toBeNull();
    expect(formatTwinDigestLine({ count: 3, avgDistance: 0.1 })).toContain("landing close");
    expect(formatTwinDigestLine({ count: 3, avgDistance: 0.9 })).toContain("mostly rewriting");
  });
});

describe("transcriptionConfig (free-first resolution)", () => {
  it("no keys anywhere -> not configured (the honest state)", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(transcriptionConfig(env)).toBeNull();
    expect(isTranscriptionConfigured(env)).toBe(false);
  });

  it("GROQ_API_KEY selects the free-tier Groq endpoint + whisper-large-v3", () => {
    const config = transcriptionConfig({ GROQ_API_KEY: "gsk-test" } as unknown as NodeJS.ProcessEnv);
    expect(config?.source).toBe("groq");
    expect(config?.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(config?.model).toBe("whisper-large-v3");
  });

  it("an explicit custom endpoint beats everything; OPENAI_API_KEY is the paid default", () => {
    const custom = transcriptionConfig({
      TRANSCRIPTION_API_KEY: "k",
      TRANSCRIPTION_BASE_URL: "http://localhost:9000/v1",
      GROQ_API_KEY: "gsk-test",
      OPENAI_API_KEY: "sk-test",
    } as unknown as NodeJS.ProcessEnv);
    expect(custom?.source).toBe("custom");
    expect(custom?.baseUrl).toBe("http://localhost:9000/v1");
    const openai = transcriptionConfig({ OPENAI_API_KEY: "sk-test" } as unknown as NodeJS.ProcessEnv);
    expect(openai?.source).toBe("openai");
    expect(openai?.model).toBe("whisper-1");
  });
});
