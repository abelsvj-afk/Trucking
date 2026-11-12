// Frontier 2 — the agent-episodes tools: list / save / correct
// lessons over the store surface (no database here — a stub
// store records the calls).

import { describe, expect, it, vi } from "vitest";
import type { BotBrainStore } from "@/services/bot/store";
import { buildEpisodeTools } from "@/services/bot/episode-tools";
import type { EpisodeRow } from "@/services/bot/episodes";

function stubStore(overrides: Partial<BotBrainStore> = {}): BotBrainStore {
  return {
    listEpisodes: async () => [] as EpisodeRow[],
    saveEpisode: async () => "ep-new",
    correctEpisode: async () => "ep-corrected",
    ...overrides,
  } as unknown as BotBrainStore;
}

describe("episode tools", () => {
  it("list_agent_lessons shows current lessons with ids and evidence", async () => {
    const store = stubStore({
      listEpisodes: async () => [
        { id: "ep-1", kind: "learned", summary: "Morning digest flops", situation: "Dropped 3 morning digests.", lesson: "Only suggest a morning digest when he asks.", valence: "hurt", confidence: 0.9, provenance: "model_inferred_unconfirmed", created_at: "2026-11-10T08:00:00.000Z", valid_to: null, superseded_by: null },
      ] as EpisodeRow[],
    });
    const [tool] = buildEpisodeTools(store).filter((t) => t.name === "list_agent_lessons");
    const out = await tool!.run({});
    expect(out).toContain("[ep-1]");
    expect(out).toContain("Only suggest a morning digest when he asks.");
    expect(out).toContain("evidence: Dropped 3 morning digests.");
    expect(await tool!.run({ query: "fuel" })).toContain('No lesson mentions "fuel"');
  });

  it("save_agent_lesson records a learned lesson through the store", async () => {
    const saveEpisode = vi.fn(async () => "ep-new");
    const store = stubStore({ saveEpisode });
    const [tool] = buildEpisodeTools(store).filter((t) => t.name === "save_agent_lesson");
    expect(tool!.summarize!({ summary: "S", lesson: "L" })).toBe('Lesson learned: "L"');
    const out = await tool!.run({ summary: "Morning digest flops", lesson: "Only suggest one when he asks.", valence: "hurt", confidence: 0.9 });
    expect(out).toContain("Saved lesson");
    expect(saveEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "learned", lesson: "Only suggest one when he asks.", confidence: 0.9 }),
    );
  });

  it("correct_agent_lesson corrects through the store (superseding, owner-stated)", async () => {
    const correctEpisode = vi.fn(async () => "ep-corrected");
    const store = stubStore({ correctEpisode });
    const [tool] = buildEpisodeTools(store).filter((t) => t.name === "correct_agent_lesson");
    const out = await tool!.run({ episode_id: "11111111-1111-4111-8111-111111111111", lesson: "Only on Mondays." });
    expect(out).toContain("Corrected the lesson");
    expect(correctEpisode).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "Only on Mondays.");
  });

  it("registers exactly the three F2 tools", () => {
    expect(buildEpisodeTools(stubStore()).map((t) => t.name).sort()).toEqual([
      "correct_agent_lesson",
      "list_agent_lessons",
      "save_agent_lesson",
    ]);
  });
});
