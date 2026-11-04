// Research requests (Research Intelligence design D-5; table from
// migration 00040, Abel's conversational side is R-6). The contract
// between the research engine and the conversation:
//
// - The research side ASKS by writing a row (requestPretripPhotos):
//   kind 'pretrip_photo', detail carrying what to photograph and why.
// - Abel's side READS pending rows (listPendingResearchRequests),
//   asks him in the conversation, and can dismiss an ask he declines
//   (dismissResearchRequest). Marking a request FULFILLED belongs to
//   photo intake (the img-maint lane): when a MATCHING photo is
//   filed, that pipeline stamps fulfilled_at via
//   fulfilMatchingPretripRequest below — matching means the ask's
//   load (when it carries one) equals the photo's load AND the
//   photo's evidence covers EVERY item the ask requested (UH-03 fix:
//   one tire photo no longer discharges a BOL ask or a 4-item ask).
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

// ---------------------------------------------------------------------------
// UH-03 fix: the matching fulfilment writer (single source of the rule;
// photo-purpose.ts on the img-maint lane implements the same contract).
// ---------------------------------------------------------------------------

const ITEM_PATTERNS: { match: RegExp; evidence: RegExp }[] = [
  { match: /bol|bill of lading/i, evidence: /\bbol\b|bill of lading/i },
  { match: /tire|tyre|wheel/i, evidence: /tire|tyre|wheel|tread/i },
  { match: /light|lamp/i, evidence: /light|lamp|headlight|brake light/i },
  { match: /secure|strap|chain|tarp/i, evidence: /secure|strap|chain|tarp|binder/i },
  { match: /brake/i, evidence: /brake/i },
  { match: /mirror/i, evidence: /mirror/i },
  { match: /fluid|leak/i, evidence: /fluid|leak/i },
  { match: /coupling|fifth|gladhand/i, evidence: /coupling|fifth wheel|gladhand/i },
];

/** True when the evidence text covers every requested item. */
export function pretripItemsCovered(items: string[], evidenceText: string): boolean {
  // An ask that names NO items asked only for "a pre-trip photo" —
  // coverage is vacuous. (The writer always records items; this is
  // for degenerate rows.) An ask WITH items requires every one.
  if (items.length === 0) return true;
  return items.every((item) => {
    const known = ITEM_PATTERNS.find((p) => p.match.test(item));
    if (known) return known.evidence.test(evidenceText);
    const word = item.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return word.length >= 3 && evidenceText.toLowerCase().includes(word);
  });
}

/** The matching rule, pure: load match (when load-scoped) + full item coverage. */
export function pretripRequestMatches(
  request: ResearchRequestRow,
  input: { evidenceText: string; loadId: string | null },
): boolean {
  if (request.load_id && input.loadId !== request.load_id) return false;
  // Raw recorded items only: an ask that recorded none asked only
  // for "a pre-trip photo" (vacuous coverage). requestPhotoItems'
  // display defaults must not become a fulfilment requirement.
  const itemsRaw = (request.detail as { items?: unknown }).items;
  const items = Array.isArray(itemsRaw)
    ? itemsRaw.filter((i): i is string => typeof i === "string" && i.length > 0)
    : [];
  return pretripItemsCovered(items, input.evidenceText);
}

/**
 * Fulfil the OLDEST queued pretrip_photo ask that MATCHES the filed
 * photo. Returns the fulfilled request id, or null when nothing
 * matched (the ask stays queued — a non-matching photo changes
 * nothing). Photo intake calls this; this module owns the rule.
 */
export async function fulfilMatchingPretripRequest(
  client: SupabaseClient,
  companyId: string,
  input: { evidenceText: string; loadId: string | null },
): Promise<string | null> {
  const pending = await listPendingResearchRequests(client, companyId, 5);
  const match = pending.find((r) => r.kind === "pretrip_photo" && pretripRequestMatches(r, input));
  if (!match) return null;
  const { error } = await client
    .from("research_requests")
    .update({ status: "fulfilled", fulfilled_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("id", match.id)
    .eq("status", "queued");
  if (error) throw new Error(error.message);
  return match.id;
}
