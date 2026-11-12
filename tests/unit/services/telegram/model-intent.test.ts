// Frontier 2 — Telegram /model: intent triggers (not a command
// system), the read rendering, and correct-by-reply staging.

import { describe, expect, it, vi } from "vitest";
import {
  handleModelCorrection,
  handleModelRead,
  isModelReadRequest,
  parseModelCorrection,
} from "@/services/telegram/model-intent";
import type { TelegramStore } from "@/services/telegram/store";
import type { WhatIKnowModel } from "@/services/bot/what-i-know";

describe("isModelReadRequest", () => {
  it("triggers on /model and the plain-words asks", () => {
    expect(isModelReadRequest("/model")).toBe(true);
    expect(isModelReadRequest("  /model  ")).toBe(true);
    expect(isModelReadRequest("what do you know about me")).toBe(true);
    expect(isModelReadRequest("What do you know about me?")).toBe(true);
    expect(isModelReadRequest("show me my model")).toBe(true);
    expect(isModelReadRequest("show me what you know")).toBe(true);
  });
  it("does not trigger on anything else — everything else stays conversation", () => {
    expect(isModelReadRequest("/models")).toBe(false);
    expect(isModelReadRequest("what do you know about trucking")).toBe(false);
    expect(isModelReadRequest("show me my loads")).toBe(false);
    expect(isModelReadRequest("hello")).toBe(false);
  });
});

describe("parseModelCorrection", () => {
  it("parses the correction forms", () => {
    expect(parseModelCorrection("correct lesson 2: only on Mondays")).toEqual({
      lessonNumber: 2, lesson: "only on Mondays",
    });
    expect(parseModelCorrection("fix 1 - never suggest it")).toEqual({
      lessonNumber: 1, lesson: "never suggest it",
    });
    expect(parseModelCorrection("lesson 3 is wrong, he likes mornings")).toEqual({
      lessonNumber: 3, lesson: "he likes mornings",
    });
    expect(parseModelCorrection("2 is wrong: only on Mondays")).toEqual({
      lessonNumber: 2, lesson: "only on Mondays",
    });
  });
  it("returns null for anything that is not a correction", () => {
    expect(parseModelCorrection("correct that")).toBeNull();
    expect(parseModelCorrection("lesson 2")).toBeNull();
    expect(parseModelCorrection("yes")).toBeNull();
  });
});

const model: WhatIKnowModel = {
  beliefs: [{ id: "b1", kind: "fact", content: "Carrier settles Thursdays.", created_at: "2026-11-10T08:00:00.000Z", valid_to: null, superseded_by: null }],
  preferences: [],
  other: [],
  lessons: [
    { id: "ep-1", kind: "learned", summary: "Morning digest flops", situation: "Dropped 3 morning digests.", lesson: "Only suggest a morning digest when he asks.", valence: "hurt", confidence: 0.9, provenance: "model_inferred_unconfirmed", created_at: "2026-11-10T08:00:00.000Z", valid_to: null, superseded_by: null, evidence: "Dropped 3 morning digests." },
    { id: "ep-2", kind: "learned", summary: "Fuel stop helped", situation: "Flagged the cheap stop.", lesson: "Flag the cheap fuel stop before a long leg.", valence: "helped", confidence: 0.8, provenance: "model_inferred_unconfirmed", created_at: "2026-11-09T08:00:00.000Z", valid_to: null, superseded_by: null, evidence: "Flagged the cheap stop." },
  ],
};

function stubStore(): TelegramStore & { staged: { episodeId: string; lesson: string }[] } {
  const staged: { episodeId: string; lesson: string }[] = [];
  return {
    getWhatIKnow: async () => model,
    stageLessonCorrection: async (episodeId: string, lesson: string) => {
      staged.push({ episodeId, lesson });
    },
    staged,
  } as unknown as TelegramStore & { staged: { episodeId: string; lesson: string }[] };
}

describe("handleModelRead", () => {
  it("renders beliefs, preferences, and lessons with evidence", async () => {
    const text = await handleModelRead(stubStore());
    expect(text).toContain("What I know about you:");
    expect(text).toContain("Carrier settles Thursdays.");
    expect(text).toContain("1. Only suggest a morning digest when he asks. (from: Dropped 3 morning digests.)");
    expect(text).toContain("tell me which one and what's right");
  });
  it("answers honestly when the store has no model surface", async () => {
    const text = await handleModelRead({} as TelegramStore);
    expect(text).toContain("isn't configured");
  });
});

describe("handleModelCorrection (correct-by-reply staging)", () => {
  it("stages the correction for lesson 2 — never auto-applies", async () => {
    const store = stubStore();
    const result = await handleModelCorrection(store, "correct lesson 2: only on Mondays");
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Staged for your yes");
    expect(result.reply).toContain("only on Mondays");
    expect(store.staged).toEqual([{ episodeId: "ep-2", lesson: "only on Mondays" }]);
  });
  it("names the count when the number has no lesson", async () => {
    const store = stubStore();
    const result = await handleModelCorrection(store, "correct lesson 9: something else");
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("only have 2 lessons");
    expect(store.staged).toEqual([]);
  });
  it("refuses to stage on a read-only turn (dedup claim failed)", async () => {
    const store = stubStore();
    const result = await handleModelCorrection(store, "correct lesson 1: x", { writesRefused: true });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("couldn't stage that correction");
    expect(store.staged).toEqual([]);
  });
  it("does not handle non-corrections", async () => {
    expect(await handleModelCorrection(stubStore(), "hello")).toEqual({ handled: false, reply: "" });
  });
});
