// The outcome log's store slice (migration 00076). Best-effort by design: a missing table (migration not applied yet)
// or any failed write/read is swallowed - learning must never be able to break or slow a conversation.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BotBrainStore, BotChannel } from "./store";
import { signatureOf, WINDOW_DAYS, type Outcome, type OutcomeRow } from "./learning";

export type OutcomesStoreMethods = Pick<BotBrainStore, "recordProposalOutcome" | "loadRecentOutcomes" | "markCandidateOutcome">;

export function createOutcomesStore(supabase: SupabaseClient, company: string, channel: BotChannel): OutcomesStoreMethods {
  return {
    async recordProposalOutcome(entry) {
      try {
        const { error } = await supabase.from("bot_proposal_outcomes").insert({
          company_id: company,
          tool_name: entry.tool,
          signature: signatureOf(entry.tool, entry.args),
          outcome: entry.outcome,
          summary: entry.summary.slice(0, 500),
          arguments: entry.args,
          channel,
        });
        if (error) console.error("[bot] outcome not logged:", error.message);
      } catch (err) {
        console.error("[bot] outcome not logged:", err instanceof Error ? err.message : "error");
      }
    },

    async markCandidateOutcome(candidateId, outcome) {
      // approved = he saved it as a draft load ("taken"); dropped = "no" ("passed"); anything else that ends the offer = expired.
      const status = outcome === "approved" ? "taken" : outcome === "dropped" ? "passed" : outcome === "expired" || outcome === "replaced" ? "expired" : null;
      if (!status) return;
      try {
        await supabase
          .from("load_candidates")
          .update({ status, updated_at: new Date().toISOString() })
          .eq("id", candidateId)
          .eq("company_id", company)
          .eq("status", "proposed");
      } catch {
        /* learning must never affect a conversation */
      }
    },

    async loadRecentOutcomes(): Promise<OutcomeRow[]> {
      try {
        const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
        const { data, error } = await supabase
          .from("bot_proposal_outcomes")
          .select("tool_name, signature, outcome, summary, created_at")
          .eq("company_id", company)
          .is("deleted_at", null)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(400);
        if (error) return [];
        return (data ?? []) as OutcomeRow[];
      } catch {
        return [];
      }
    },
  };
}

export type { Outcome };
