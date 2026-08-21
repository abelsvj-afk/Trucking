// Thin client-side fetch wrapper for our own /api/v1/* routes. Every
// screen state (loading/empty/populated/error, per docs/design/ui-ux.md)
// is driven off what this returns, not ad hoc per-screen fetch logic.

import type { FinancialSummary } from "@/types/financial-summary";

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export class ApiClientError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
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
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
  // Documents don't fit the generic list/create/remove shape above -
  // multipart upload, filtered by related entity, no PATCH
  // (docs/api-contracts.md) - so they get their own three methods.
  uploadDocument: <T>(meta: {
    file: File;
    related_entity_type: string;
    related_entity_id: string;
    file_name?: string;
  }) => {
    const formData = new FormData();
    formData.append("file", meta.file);
    formData.append("related_entity_type", meta.related_entity_type);
    formData.append("related_entity_id", meta.related_entity_id);
    if (meta.file_name) formData.append("file_name", meta.file_name);
    return request<T>("/api/v1/documents", { method: "POST", body: formData });
  },
  listDocuments: <T>(relatedEntityType: string, relatedEntityId: string) => {
    const qs = new URLSearchParams({
      related_entity_type: relatedEntityType,
      related_entity_id: relatedEntityId,
    });
    return request<{ data: T[] }>(`/api/v1/documents?${qs.toString()}`);
  },
  removeDocument: (id: string) => request<void>(`/api/v1/documents/${id}`, { method: "DELETE" }),
  // Computed, read-only (docs/api-contracts.md) - omit params for the
  // server's current-calendar-month default.
  financialSummary: (params?: { from: string; to: string }) => {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    return request<FinancialSummary>(`/api/v1/financial-summary${qs}`);
  },
};
