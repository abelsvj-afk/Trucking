// The memory + capability-flag slice of the bot store (Abel Intelligence Upgrade,
// Lane 2 Phases A+B): fact retrieval, instruction memories, the latest summary,
// the capability switches (fail-closed), and the owner-facing memory list / edit / delete.
// Split out of store.ts (decomposition pass, behavior-preserving).

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "./tool-helpers";
import { getEmbeddingProvider } from "./embeddings";
import { loadAllInstructions, retrieveCurrentFacts, type RetrievedFact } from "./memory-retrieval";
import { MEMORY_CONSOLIDATION_CAPABILITY } from "./consolidation";
import { recordErredEpisode } from "./episodes";
import { PHOTO_INTELLIGENCE_CAPABILITY } from "@/services/ai/photo-classification";
import { MAINTENANCE_WATCH_CAPABILITY } from "@/services/fleet/maintenance-watch";
import { LIVE_LOCATION_CAPABILITY } from "@/lib/live-motion";
import { LOGGING_REMINDERS_CAPABILITY } from "@/lib/reminders";
import type { BotMemoryRow } from "@/services/telegram/context";
import type { BotBrainStore } from "./store";

export type MemoryStoreMethods = Pick<BotBrainStore, "retrieveFacts" | "loadInstructionMemories" | "loadLatestSummary" | "isMemoryConsolidationEnabled" | "isPhotoIntelligenceEnabled" | "isLoggingRemindersEnabled" | "isLiveLocationEnabled" | "isMaintenanceWatchEnabled" | "listMemories" | "editMemory" | "deleteMemory">;

export function createMemoryStore(
  supabase: SupabaseClient,
  company: string,
  capabilityEnabled: (capability: string) => Promise<boolean>,
): MemoryStoreMethods {
  return {

    async retrieveFacts(query: string) {
      return retrieveCurrentFacts(supabase, company, query, {
        embedder: getEmbeddingProvider(),
      });
    },

    async loadInstructionMemories() {
      return loadAllInstructions(supabase, company);
    },

    async loadLatestSummary() {
      const { data, error } = await supabase
        .from("conversation_summaries")
        .select("week_start, summary")
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("week_start", { ascending: false })
        .limit(1);
      if (error) {
        // Graceful absence: migration 00032 not applied yet.
        if (/conversation_summaries/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
          return null;
        }
        throw new Error(error.message);
      }
      const row = (data ?? [])[0] as { week_start: string; summary: string } | undefined;
      return row ? { weekStart: row.week_start, summary: row.summary } : null;
    },

    async isMemoryConsolidationEnabled() {
      return capabilityEnabled(MEMORY_CONSOLIDATION_CAPABILITY);
    },

    async isPhotoIntelligenceEnabled() {
      return capabilityEnabled(PHOTO_INTELLIGENCE_CAPABILITY);
    },

    async isLoggingRemindersEnabled() {
      return capabilityEnabled(LOGGING_REMINDERS_CAPABILITY);
    },

    async isLiveLocationEnabled() {
      // Default ON (opt-in by sharing); only an explicit off row or the global switch stops it.
      const [companyResult, capabilityResult] = await Promise.all([
        supabase.from("companies").select("ai_globally_disabled").eq("id", company).single(),
        supabase.from("ai_capability_settings").select("enabled").eq("company_id", company).eq("capability", LIVE_LOCATION_CAPABILITY).maybeSingle(),
      ]);
      if (companyResult.error || capabilityResult.error) return false; // can't verify the switch: fail closed
      const globallyDisabled = (companyResult.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled ?? false;
      const row = capabilityResult.data as { enabled: boolean } | null;
      return !globallyDisabled && (row ? row.enabled : true);
    },

    async isMaintenanceWatchEnabled() {
      return capabilityEnabled(MAINTENANCE_WATCH_CAPABILITY);
    },

    async listMemories(options?: { includeHistory?: boolean; limit?: number }) {
      const run = (withLifecycle: boolean) => {
        let q = supabase
          .from("bot_memories")
          .select(
            withLifecycle
              ? "id, kind, content, created_at, valid_to, superseded_by"
              : "id, kind, content, created_at",
          )
          .eq("company_id", company)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(options?.limit ?? 500);
        if (withLifecycle && !options?.includeHistory) q = q.is("valid_to", null);
        return q;
      };
      let result = await run(true);
      if (result.error && isMissingColumnError(result.error)) result = await run(false);
      if (result.error) throw new Error(result.error.message);
      return ((result.data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        content: String(row.content),
        created_at: String(row.created_at),
        valid_to: typeof row.valid_to === "string" ? row.valid_to : null,
        superseded_by: typeof row.superseded_by === "string" ? row.superseded_by : null,
      })) as (RetrievedFact & { valid_to: string | null; superseded_by: string | null })[];
    },

    async editMemory(this: BotBrainStore, id: string, content: string) {
      const { data: existing, error: loadError } = await supabase
        .from("bot_memories")
        .select("id, kind, content")
        .eq("id", id)
        .eq("company_id", company)
        .is("deleted_at", null)
        .maybeSingle();
      if (loadError) throw new Error(loadError.message);
      if (!existing) throw new Error("That memory doesn't exist (or was already deleted).");
      const kind = (existing as { kind: BotMemoryRow["kind"] }).kind;
      const oldContent = (existing as { content: string }).content;
      // The correction lands as a NEW row that supersedes the old
      // one - history keeps the original wording and its dates.
      const newId = await this.saveMemory(kind, content, {
        supersedesId: id,
        provenance: "owner_stated",
      });
      if (!newId) throw new Error("The corrected memory couldn't be saved.");
      // Frontier 2 (correction path, erred, free): the owner
      // corrected Abel — capture old → new and the lesson it
      // taught. Best-effort; the edit itself already landed.
      await recordErredEpisode(supabase, company, {
        oldText: oldContent,
        newText: content,
        context: "memory correction",
      });
      return newId;
    },

    async deleteMemory(id: string) {
      const { error } = await supabase
        .from("bot_memories")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .eq("company_id", company)
        .is("deleted_at", null);
      if (error) throw new Error(error.message);
    },

  };
}
