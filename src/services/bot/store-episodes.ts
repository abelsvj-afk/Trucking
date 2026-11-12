// Frontier 2 (Remember better) — the agent_episodes slice of the
// bot store: the autobiography namespace over the same Supabase
// client + company scope as everything else in the brain store.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getEmbeddingProvider } from "./embeddings";
import { memorySupersessionChain } from "./memory-lifecycle";
import {
  correctEpisode,
  episodeSupersessionChain,
  listEpisodes,
  saveEpisode,
  type EpisodeInput,
  type EpisodeRow,
} from "./episodes";
import { recallLessons, type LessonRecall } from "./lesson-recall";
import { loadWhatIKnowModel, type WhatIKnowModel } from "./what-i-know";
import type { BotBrainStore, BotChannel } from "./store";
import type { OutcomeRow } from "./learning";

export type EpisodeStoreMethods = Pick<
  BotBrainStore,
  "listEpisodes" | "saveEpisode" | "correctEpisode" | "recallLessons" | "getWhatIKnow" | "episodeChain" | "memoryChain" | "stageLessonCorrection"
>;

export function createEpisodeStore(
  supabase: SupabaseClient,
  company: string,
  channel: BotChannel,
): EpisodeStoreMethods {
  return {
    async listEpisodes(options?: { includeHistory?: boolean; limit?: number }) {
      return listEpisodes(supabase, company, options);
    },

    async saveEpisode(input: EpisodeInput) {
      return saveEpisode(supabase, company, input, { embedder: getEmbeddingProvider() });
    },

    async correctEpisode(id: string, lesson: string) {
      return correctEpisode(supabase, company, id, lesson);
    },

    async recallLessons(
      situation: string,
      options?: { category?: string; outcomeRows?: OutcomeRow[]; now?: Date },
    ): Promise<LessonRecall> {
      return recallLessons(supabase, company, situation, getEmbeddingProvider(), options);
    },

    async getWhatIKnow(): Promise<WhatIKnowModel> {
      return loadWhatIKnowModel(supabase, company);
    },

    async episodeChain(id: string): Promise<EpisodeRow[]> {
      return episodeSupersessionChain(supabase, company, id);
    },

    async memoryChain(id: string) {
      return memorySupersessionChain(supabase, company, id);
    },

    /**
     * Correct-by-reply staging (Telegram /model): the correction
     * is STAGED as a correct_agent_lesson proposal — never
     * auto-applied. His yes executes it through the normal
     * proposal path; his no drops it.
     */
    async stageLessonCorrection(episodeId: string, lesson: string) {
      const { error } = await supabase.from("bot_pending_actions").insert({
        company_id: company,
        channel,
        tool_name: "correct_agent_lesson",
        arguments: { episode_id: episodeId, lesson },
        summary: `Correct a lesson I learned: change it to "${lesson}"?`,
      });
      if (error) throw new Error(error.message);
    },
  };
}
