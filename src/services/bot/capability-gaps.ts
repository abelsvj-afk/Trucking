// Abel's "can't do that yet" list (docs/design/abel-do-what-i-ask.md section 1, owner 2026-11-16).
// When he asks for something no tool can do, Abel records the ask here and tells him plainly. Recording a gap
// changes no business record, so the tool runs immediately (like a log line), never as a yes/no proposal.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";

export interface CapabilityGap {
  id: string;
  asked: string;
  missing: string;
  times_asked: number;
  status: "open" | "built" | "dismissed";
  created_at: string;
  last_asked_at: string;
}

const COLUMNS = "id, asked, missing, times_asked, status, created_at, last_asked_at";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Records the ask, or bumps the open gap with the same "missing" text. Returns the times asked. */
export async function recordCapabilityGap(client: SupabaseClient, companyId: string, asked: string, missing: string): Promise<number> {
  const open = await client
    .from("abel_capability_gaps")
    .select(COLUMNS)
    .eq("company_id", companyId)
    .eq("status", "open")
    .is("deleted_at", null)
    .limit(200);
  if (open.error) throw new Error(open.error.message);
  const same = ((open.data ?? []) as CapabilityGap[]).find((g) => norm(g.missing) === norm(missing));
  const now = new Date().toISOString();
  if (same) {
    const times = same.times_asked + 1;
    const { error } = await client
      .from("abel_capability_gaps")
      .update({ times_asked: times, last_asked_at: now, asked: asked.slice(0, 1000) })
      .eq("id", same.id)
      .eq("company_id", companyId);
    if (error) throw new Error(error.message);
    return times;
  }
  const { error } = await client
    .from("abel_capability_gaps")
    .insert({ company_id: companyId, asked: asked.slice(0, 1000), missing: missing.slice(0, 500) });
  if (error) throw new Error(error.message);
  return 1;
}

export async function listOpenCapabilityGaps(client: SupabaseClient, companyId: string): Promise<CapabilityGap[]> {
  const { data, error } = await client
    .from("abel_capability_gaps")
    .select(COLUMNS)
    .eq("company_id", companyId)
    .eq("status", "open")
    .is("deleted_at", null)
    .order("last_asked_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as CapabilityGap[];
}

export async function dismissCapabilityGap(client: SupabaseClient, companyId: string, id: string): Promise<void> {
  const { error } = await client.from("abel_capability_gaps").update({ status: "dismissed" }).eq("id", id).eq("company_id", companyId);
  if (error) throw new Error(error.message);
}

export function buildCapabilityGapTools(store: BotBrainStore): AgentTool[] {
  return [
    {
      name: "note_capability_gap",
      description:
        "Call this when he asks for something you have NO tool for (after checking find_more_tools): it records his ask on his 'what Abel can't do yet' list so it gets built. " +
        "Then tell him plainly what you can't do and, if one exists, the closest thing you CAN do - never pretend, never quietly do something else instead. Changes no business record.",
      parameters: {
        type: "object",
        properties: {
          asked: { type: "string", description: "What he asked, in his words." },
          missing: { type: "string", description: "What is missing, in plain words (e.g. 'booking a parking spot online')." },
        },
        required: ["asked", "missing"],
      },
      // Read access on purpose: it records an ask, it changes nothing he owns, and it must work on a
      // read-only turn too. Never staged as a proposal.
      access: "read",
      async run(args) {
        const asked = String(args.asked ?? "").trim();
        const missing = String(args.missing ?? "").trim();
        if (!asked || !missing) return "Say what he asked and what is missing.";
        try {
          const times = await recordCapabilityGap(store.client, store.companyId, asked, missing);
          return `Recorded on his "what Abel can't do yet" list (More → What Abel can't do yet)${times > 1 ? ` - he has asked for this ${times} times` : ""}. Tell him plainly you can't do it yet and that it's on the list.`;
        } catch (err) {
          console.error("[bot] capability gap not recorded", err);
          return "The list could not be saved right now. Still tell him plainly that you can't do this yet.";
        }
      },
    },
  ];
}
