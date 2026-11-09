// Thin client-side fetch wrapper for our own /api/v1/* routes. Every
// screen state (loading/empty/populated/error, per docs/design/ui-ux.md)
// is driven off what this returns, not ad hoc per-screen fetch logic.

import type { PaperLogListItem, PaperLogReview, PaperLogSaveBody } from "@/types/paper-logs";
import type { FinancialSummary, FinancialSummaryDetail } from "@/types/financial-summary";
import type { AiSettings } from "@/types/ai-settings";
import type { DutyLogWindowSummary, HosSettings } from "@/types/hos-settings";
import type { DutyLog } from "@/types/entities";
import { viewerTimeZone } from "@/lib/time";
import type { ServiceStatus } from "@/types/service-status";
import type {
  CheckWiresResult,
  DetentionStamp,
  ResearchBriefing,
  ResearchPageData,
  ResearchRun,
} from "@/types/entities";
import type { DetentionSummary } from "@/lib/detention";
import type { PaperworkState } from "@/lib/paperwork";
import type { FundSettingsView, LadderStepView, TruckFundOverview } from "@/types/truck-fund";
import type { GamePlanPageData } from "@/types/game-plan";
import type { GamePlan, GameTarget } from "@/types/entities";
import type { LoadEconomics } from "@/lib/load-economics";
import type { PaySummary } from "@/services/api/pay-summary";

/** One row of the "What Abel remembers" list (Lane 2, Phase B). */
export interface BotMemoryListItem {
  id: string;
  kind: string;
  content: string;
  created_at: string;
  valid_to: string | null;
  superseded_by: string | null;
}

/** The night shift's staleness status, riding the memories list response (fix round, pitfall hunt CD-1). Null when the server couldn't produce one. */
export interface BotConsolidationStatus {
  enabled: boolean;
  known: boolean;
  stale: boolean;
  lastRanAt: string | null;
  hoursSinceLastRun: number | null;
}

export interface BotMemoryListResult {
  data: BotMemoryListItem[];
  consolidation: BotConsolidationStatus | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: { path: string; message: string }[] };
}

export class ApiClientError extends Error {
  code: string;
  status: number;
  // Field-level errors when the API returns them (Unit A/F 422s), so
  // edit forms can show WHAT is wrong, not just that something is.
  fields?: { path: string; message: string }[];

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: { path: string; message: string }[],
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // A FormData body (document upload) must NOT get a manual Content-Type -
  // the browser sets its own multipart boundary, which a hardcoded
  // "application/json" would break.
  const isFormData = init?.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    headers: isFormData ? init?.headers : { "Content-Type": "application/json", ...init?.headers },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiClientError(
      res.status,
      body?.error.code ?? "UNKNOWN_ERROR",
      body?.error.message ?? "Something went wrong. Please try again.",
      body?.error.fields,
    );
  }

  notifyMutation(path, init?.method);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Window event the live layer listens to: a write this tab just made. */
export const MUTATION_EVENT = "trucking:mutation";

// After a successful write, tell the live layer so the open page
// refreshes at once - before (or without) the Realtime echo.
function notifyMutation(path: string, method: string | undefined) {
  if (!method || method.toUpperCase() === "GET") return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MUTATION_EVENT, { detail: { path } }));
}

export interface ListResponse<T> {
  data: T[];
  page: { limit: number; offset: number; total: number };
}

export const apiClient = {
  list: <T>(resource: string, params?: Record<string, string>) => {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    return request<ListResponse<T>>(`/api/v1/${resource}${qs}`);
  },
  get: <T>(resource: string, id: string) =>
    request<T>(`/api/v1/${resource}/${id}`),
  create: <T>(resource: string, body: Record<string, unknown>) =>
    request<T>(`/api/v1/${resource}`, { method: "POST", body: JSON.stringify(body) }),
  update: <T>(resource: string, id: string, body: Record<string, unknown>) =>
    request<T>(`/api/v1/${resource}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  remove: (resource: string, id: string) =>
    request<void>(`/api/v1/${resource}/${id}`, { method: "DELETE" }),
  // Restore a soft-deleted record (Reliability Unit A): POST
  // /api/v1/{resource}/{id}/restore. A refusal is a 422 ApiClientError
  // whose message names the reason (deleted parent, invalid record...).
  // The Deleted view of a list is the plain list call with
  // params { deleted: "only" }.
  restore: <T>(resource: string, id: string) =>
    request<T>(`/api/v1/${resource}/${id}/restore`, { method: "POST" }),
  // Documents don't fit the generic list/create/remove shape above -
  // multipart upload, filtered by related entity, no PATCH
  // (docs/api-contracts.md) - so they get their own three methods.
  uploadDocument: <T>(meta: {
    file: File;
    related_entity_type: string;
    related_entity_id: string;
    file_name?: string;
    /** Document creation spec (00085): paperwork kind + situation, when the surface knows them. */
    doc_type?: string;
    situation?: string;
  }) => {
    const formData = new FormData();
    formData.append("file", meta.file);
    formData.append("related_entity_type", meta.related_entity_type);
    formData.append("related_entity_id", meta.related_entity_id);
    if (meta.file_name) formData.append("file_name", meta.file_name);
    if (meta.doc_type) formData.append("doc_type", meta.doc_type);
    if (meta.situation) formData.append("situation", meta.situation);
    return request<T>("/api/v1/documents", { method: "POST", body: formData });
  },
  /** Create a document in the app (POST /api/v1/documents/generate): templates + generator seam server-side. */
  generateDocument: <T>(body: Record<string, unknown>) =>
    request<T>("/api/v1/documents/generate", { method: "POST", body: JSON.stringify(body) }),
  listDocuments: <T>(relatedEntityType: string, relatedEntityId: string) => {
    const qs = new URLSearchParams({
      related_entity_type: relatedEntityType,
      related_entity_id: relatedEntityId,
    });
    return request<{ data: T[] }>(`/api/v1/documents?${qs.toString()}`);
  },
  // Full-text search over extracted document text (docs/api-contracts.md,
  // design driver-mvp.md §10) - searches across all records unless the
  // caller scopes it to one.
  searchDocuments: <T>(query: string, scope?: { relatedEntityType: string; relatedEntityId: string }) => {
    const params: Record<string, string> = { q: query };
    if (scope) {
      params.related_entity_type = scope.relatedEntityType;
      params.related_entity_id = scope.relatedEntityId;
    }
    const qs = new URLSearchParams(params);
    return request<{ data: T[] }>(`/api/v1/documents?${qs.toString()}`);
  },
  removeDocument: (id: string) => request<void>(`/api/v1/documents/${id}`, { method: "DELETE" }),
  // Retention-delete lifecycle (Unit A / F-007): the Deleted view of a
  // record's documents (tombstones carry retention status and no signed
  // URLs), restore, and the cleanup-incident surface (F-038) - open
  // incidents plus the per-incident removal retry.
  listDeletedDocuments: <T>(relatedEntityType: string, relatedEntityId: string) => {
    const qs = new URLSearchParams({
      related_entity_type: relatedEntityType,
      related_entity_id: relatedEntityId,
      deleted: "only",
    });
    return request<{ data: T[] }>(`/api/v1/documents?${qs.toString()}`);
  },
  // GAP-04/05 (Fresh-Eyes Register 2026-11-02): the load's facility
  // clock + paperwork state — nested under the load, computed
  // server-side by src/lib/detention.ts / src/lib/paperwork.ts.
  detention: (loadId: string) =>
    request<{ data: DetentionStamp[]; summary: DetentionSummary }>(
      `/api/v1/loads/${loadId}/detention-stamps`,
    ),
  stampDetention: (loadId: string, body: Record<string, unknown>) =>
    request<{ data: DetentionStamp }>(`/api/v1/loads/${loadId}/detention-stamps`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  loadPaperwork: (loadId: string) =>
    request<{ data: PaperworkState }>(`/api/v1/loads/${loadId}/paperwork`),
  restoreDocument: <T>(id: string) =>
    request<T>(`/api/v1/documents/${id}/restore`, { method: "POST" }),
  listCleanupIncidents: <T>() =>
    request<{ data: T[] }>("/api/v1/documents/cleanup-incidents"),
  retryCleanupIncident: <T>(id: string) =>
    request<T>(`/api/v1/documents/cleanup-incidents/${id}/retry`, { method: "POST" }),
  // Computed, read-only (docs/api-contracts.md) - omit params for the
  // server's current-calendar-month default. The viewer's timezone
  // always rides along (Reliability Unit B, B.2.1): period semantics
  // are viewer-local, and the server reports the zone it used in the
  // response's timeZone field.
  financialSummary: (params?: { from: string; to: string }) => {
    const qs = new URLSearchParams({ ...(params ?? {}), tz: viewerTimeZone() });
    return request<FinancialSummary>(`/api/v1/financial-summary?${qs.toString()}`);
  },
  // F-010 drill-down (Unit C, C3): the rows behind one summary total.
  financialSummaryDetail: (component: string, params: { from: string; to: string }) => {
    const qs = new URLSearchParams({ component, ...params, tz: viewerTimeZone() });
    return request<FinancialSummaryDetail>(`/api/v1/financial-summary/detail?${qs.toString()}`);
  },
  // HOS carrier configuration + the duty-log calculation window
  // (Reliability Unit B, B.2.4/B.5).
  getHosSettings: () => request<HosSettings>("/api/v1/hos-settings"),
  updateHosSettings: (body: Partial<HosSettings>) =>
    request<HosSettings>("/api/v1/hos-settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  // Paper-log review (docs/design/driver-hud.md §6).
  paperLogs: () => request<{ data: PaperLogListItem[] }>("/api/v1/paper-logs"),
  readPaperLog: (documentId: string) =>
    request<{ data: PaperLogReview }>("/api/v1/paper-logs", {
      method: "POST",
      body: JSON.stringify({ document_id: documentId }),
    }),
  paperLogReview: (documentId: string) => request<{ data: PaperLogReview }>(`/api/v1/paper-logs/${documentId}`),
  savePaperLog: (documentId: string, body: PaperLogSaveBody) =>
    request<{ data: { inserted: number } }>(`/api/v1/paper-logs/${documentId}/save`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  dutyLogWindow: () =>
    request<{ data: DutyLog[]; hos: DutyLogWindowSummary }>("/api/v1/duty-logs/window"),
  /** Background tracking: the native shell's device tokens. The secret comes back ONCE, from create. */
  deviceTokens: () => request<{ data: { id: string; label: string; created_at: string; last_used_at: string | null }[] }>("/api/v1/device-tokens"),
  createDeviceToken: (label: string) =>
    request<{ data: { id: string; label: string; created_at: string; token: string } }>("/api/v1/device-tokens", { method: "POST", body: JSON.stringify({ label }) }),
  revokeDeviceToken: (id: string) => request<{ data: { revoked: boolean } }>(`/api/v1/device-tokens/${id}`, { method: "DELETE" }),
  /** Owner-only: how Telegram delivers to Abel (which update types, pending, last error). Plain-language findings. */
  telegramWebhook: () => request<{ data: import("@/services/telegram/webhook-admin").WebhookReport }>("/api/v1/telegram-webhook"),
  /** Owner-only: re-register the EXISTING webhook with message + edited_message + callback_query, then re-check. */
  repairTelegramWebhook: () =>
    request<{ data: import("@/services/telegram/webhook-admin").RepairResult }>("/api/v1/telegram-webhook", { method: "POST" }),
  /** The latest position Telegram Live Location sent (it keeps reporting with the app closed), or null. */
  telegramPosition: () =>
    request<{ position: { lat: number; lng: number; accuracyM: number | null; headingDeg: number | null; speedMph: number | null; recordedAt: string; ageSeconds: number } | null }>(
      "/api/v1/position",
    ),
  /** Block C: the posted limit (OSM maxspeed) for the road under the truck, or null - never an estimate. */
  speedLimit: (lat: number, lng: number, headingDeg: number | null) =>
    request<{ data: { limitMph: number | null; roadName: string | null; unavailable: boolean } }>(
      `/api/v1/map/speed-limit?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}${headingDeg !== null ? `&heading=${Math.round(headingDeg)}` : ""}`,
    ),
  /** Block A: ask the server to switch to Driving from detected sustained motion (stamped at the detection time). */
  autoMotionSwitch: (detectedAtIso: string, submissionId: string) =>
    request<{ data: { switched: boolean; reason?: string; startedAt?: string; deduplicated?: boolean } }>(
      "/api/v1/duty-logs/auto-motion",
      { method: "POST", body: JSON.stringify({ detected_at: detectedAtIso, submission_id: submissionId }) },
    ),
  loadEconomics: (loadId: string) => request<{ data: LoadEconomics }>(`/api/v1/loads/${loadId}/economics`),
  paySummary: () => request<{ data: PaySummary }>("/api/v1/pay-summary"),
  // Truck Fund + money visibility (docs/design/driver-mvp.md §9).
  truckFund: () => request<TruckFundOverview>("/api/v1/truck-fund"),
  updateFundSettings: (body: Record<string, unknown>) =>
    request<FundSettingsView>("/api/v1/truck-fund/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  updateLadderStep: (stepKey: string, body: Record<string, unknown>) =>
    request<LadderStepView>(`/api/v1/business-ladder/${stepKey}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  // Gaming System (docs/design/gaming-system.md).
  gamePlan: () => request<GamePlanPageData>("/api/v1/game-plan"),
  createGameTarget: (body: Record<string, unknown>) =>
    request<{ target: GameTarget; game: unknown }>("/api/v1/game-targets", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateGameTarget: (id: string, body: Record<string, unknown>) =>
    request<{ target: GameTarget; game: unknown }>(`/api/v1/game-targets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  regameGamePlan: () =>
    request<{ game: unknown }>("/api/v1/game-plan/regame", {
      method: "POST",
      body: JSON.stringify({ trigger: "manual" }),
    }),
  gameWhatIf: (overrides: Record<string, unknown>) =>
    request<{ game: unknown }>("/api/v1/game-plan/what-if", {
      method: "POST",
      body: JSON.stringify({ overrides }),
    }),
  promoteGamePlan: (planId: string) =>
    request<{ plan: GamePlan }>("/api/v1/game-plan/promote", {
      method: "POST",
      body: JSON.stringify({ plan_id: planId }),
    }),
  // The AI kill switches (docs/governance.md) - a normal owner-session
  // read/write, unlike everything else about an AI capability.
  // Lane 2: "What Abel remembers" - view / edit (supersede) / delete
  // over the shared brain store (Intelligence Upgrade Phase B).
  /** Company inbox (read-only): status + message summaries, or one message in full with ?id. */
  inbox: (params: { q?: string; classification?: string; mailbox?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.classification) qs.set("classification", params.classification);
    if (params.mailbox) qs.set("mailbox", params.mailbox);
    return request<{ data: { statuses: import("@/services/email/status").EmailStatus[]; sending: { mailbox: "dispatch" | "owner"; enabled: boolean; reason: string | null }[]; sendFailures: { id: string; mailbox: "dispatch" | "owner"; toAddress: string; subject: string; reason: string | null }[]; messages: import("@/services/email/store").StoredEmail[] } }>(`/api/v1/inbox${qs.size ? `?${qs}` : ""}`);
  },
  inboxMessage: (id: string) =>
    request<{ data: { statuses: import("@/services/email/status").EmailStatus[]; message: import("@/services/email/store").StoredEmail; drafts: import("@/services/email/store").DraftRow[]; sent: import("@/services/email/store").SentRow[] } }>(`/api/v1/inbox?id=${encodeURIComponent(id)}`),
  listMemories: (includeHistory = false) =>
    request<BotMemoryListResult>(`/api/v1/memories${includeHistory ? "?history=1" : ""}`),
  editMemory: (id: string, content: string) =>
    request<{ data: { id: string } }>("/api/v1/memories", {
      method: "PATCH",
      body: JSON.stringify({ id, content }),
    }),
  deleteMemory: (id: string) =>
    request<{ data: { id: string; deleted: boolean } }>("/api/v1/memories", {
      method: "DELETE",
      body: JSON.stringify({ id }),
    }),
  getAiSettings: () => request<AiSettings>("/api/v1/ai-settings"),
  updateAiSettings: (body: Partial<AiSettings>) =>
    request<AiSettings>("/api/v1/ai-settings", { method: "PATCH", body: JSON.stringify(body) }),
  dismissIndustryBriefing: <T>(id: string) =>
    request<T>(`/api/v1/industry-briefings/${id}/dismiss`, { method: "POST" }),
  listIndustryBriefings: <T>() =>
    request<{ data: T[]; service_status: ServiceStatus }>("/api/v1/industry-briefings"),
  // Bot intelligence v2 (docs/design/driver-mvp.md §8): the web chat
  // window onto the same bot brain as Telegram - one shared timeline.
  assistantHistory: () =>
    request<{ data: { role: "user" | "assistant"; text: string }[]; pending_summary: string | null }>(
      "/api/v1/assistant/chat",
    ),
  assistantChat: (message: string) =>
    request<{ reply: string; pending_summary: string | null }>("/api/v1/assistant/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  // Deep Research Engine (docs/design/research-engine.md).
  listResearchBriefings: () => request<ResearchPageData>("/api/v1/research-briefings"),
  markResearchBriefingRead: (id: string) =>
    request<ResearchBriefing>(`/api/v1/research-briefings/${id}/read`, { method: "POST" }),
  dismissResearchBriefing: (id: string) =>
    request<ResearchBriefing>(`/api/v1/research-briefings/${id}/dismiss`, { method: "POST" }),
  researchNow: (topic: string) =>
    request<ResearchRun>("/api/v1/research-briefings/research-now", {
      method: "POST",
      body: JSON.stringify({ topic }),
    }),
  // Home News Banner (2026-11-02 design §6.4): one briefing by id,
  // including dismissed - the deep-link fallback for a banner tap.
  getResearchBriefing: (id: string) => request<ResearchBriefing>(`/api/v1/research-briefings/${id}`),
  // Home News Banner (2026-11-02 design §4): the watcher-only light
  // pull - free sources, no AI call, no run-cap spend.
  checkWires: () =>
    request<CheckWiresResult>("/api/v1/research-briefings/check-wires", { method: "POST" }),
};
