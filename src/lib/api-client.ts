// Thin client-side fetch wrapper for our own /api/v1/* routes. Every
// screen state (loading/empty/populated/error, per docs/design/ui-ux.md)
// is driven off what this returns, not ad hoc per-screen fetch logic.

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
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
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
};
