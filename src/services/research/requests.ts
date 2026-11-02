// Research requests (Research Intelligence design D-5; table from
// migration 00040, Abel's conversational side is R-6). The contract
// between the research engine and the conversation:
//
// - The research side ASKS by writing a row (requestPretripPhotos):
//   kind 'pretrip_photo', detail carrying what to photograph and why.
// - Abel's side READS pending rows (listPendingResearchRequests),
//   asks him in the conversation, and can dismiss an ask he declines
//   (dismissResearchRequest). Marking a request FULFILLED belongs to
//   photo intake (the img-maint lane): when a matching photo is
//   filed, that pipeline stamps fulfilled_at - this module never
//   guesses that a photo matched.
//
// Everything here takes the caller's Supabase client and scopes every
// query to the company in code, because one of Abel's surfaces (the
// Telegram store) runs on a service-role client where RLS does not
// fence rows for us.

import type { SupabaseClient } from "@supabase/supabase-js";

export const PRETRIP_PHOTO_DEFAULT_ITEMS = [
  "tires",
  "lights",
  "load securement",
  "BOL",
] as const;

export interface ResearchRequestRow {
  id: string;
  company_id: string;
  load_id: string | null;
  kind: string;
  detail: Record<string, unknown>;
  status: string;
  created_at: string;
  fulfilled_at: string | null;
}

export interface PretripPhotoAsk {
  /** Free label for the checklist context (e.g. "pre-trip", "post-trip"). */
  checklistKind?: string;
  /** What to photograph; defaults to PRETRIP_PHOTO_DEFAULT_ITEMS. */
  items?: string[];
  /** Why the photos are wanted - Abel repeats this when he asks. */
  reason?: string;
}

const REQUEST_COLUMNS =
  "id, company_id, load_id, kind, detail, status, created_at, fulfilled_at";

/**
 * The research-side writer (design D-5): queue a pre-trip photo ask
 * for a company (optionally tied to a load). Returns the request id.
 */
export async function requestPretripPhotos(
  client: SupabaseClient,
  companyId: string,
  ask: PretripPhotoAsk & { loadId?: string | null } = {},
): Promise<string> {
  const items = (ask.items ?? []).map((i) => i.trim()).filter((i) => i.length > 0);
  const detail: Record<string, unknown> = {
    checklist_kind: ask.checklistKind?.trim() || "pre-trip",
    items: items.length > 0 ? items : [...PRETRIP_PHOTO_DEFAULT_ITEMS],
  };
  if (ask.reason?.trim()) detail.reason = ask.reason.trim();

  const { data, error } = await client
    .from("research_requests")
    .insert({
      company_id: companyId,
      load_id: ask.loadId ?? null,
      kind: "pretrip_photo",
      detail,
      status: "queued",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return String((data as { id: string }).id);
}

/** Pending (queued) asks for a company, oldest first - the order Abel should raise them. */
export async function listPendingResearchRequests(
  client: SupabaseClient,
  companyId: string,
  limit = 5,
): Promise<ResearchRequestRow[]> {
  const { data, error } = await client
    .from("research_requests")
    .select(REQUEST_COLUMNS)
    .eq("company_id", companyId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as ResearchRequestRow[];
}

/**
 * Mark one of the company's queued asks dismissed (he said skip it).
 * Returns true when a queued row was actually dismissed - a request
 * that is already fulfilled or belongs to another company is left
 * untouched and reports false.
 */
export async function dismissResearchRequest(
  client: SupabaseClient,
  companyId: string,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("research_requests")
    .update({ status: "dismissed" })
    .eq("company_id", companyId)
    .eq("id", requestId)
    .eq("status", "queued")
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** The human list of what an ask wants photographed, from its detail payload. */
export function requestPhotoItems(request: ResearchRequestRow): string[] {
  const items = (request.detail as { items?: unknown }).items;
  if (Array.isArray(items)) {
    const strings = items.filter((i): i is string => typeof i === "string" && i.length > 0);
    if (strings.length > 0) return strings;
  }
  return [...PRETRIP_PHOTO_DEFAULT_ITEMS];
}

/** The ask's stated reason, when the writer recorded one. */
export function requestReason(request: ResearchRequestRow): string | null {
  const reason = (request.detail as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}
