"use client";

// Shared list-fetching hook for every entity list screen (docs/design/ui-ux.md's
// loading/empty/populated/error states). Written once here since every
// Stage 3 entity needs the identical pattern - see fleet/trucks/page.tsx
// for the worked example. Optional `params` supports query-string filters
// (e.g. loads' ?status=draft, per docs/api-contracts.md) - refetches
// automatically when they change.
//
// Note on the useEffect shape: the effect's synchronous body only calls
// fetchList(), which itself only starts the request and attaches
// .then()/.catch() handlers - it never calls setState synchronously
// during the effect's own execution (only inside those async callbacks).
// Calling setState synchronously inside an effect body triggers
// react-hooks/set-state-in-effect and causes an extra cascading render;
// this shape avoids it by construction, not by disabling the rule.

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError, type ListResponse } from "./api-client";

export type ListState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; result: ListResponse<T> };

export function useApiList<T>(resource: string, params?: Record<string, string>) {
  const [state, setState] = useState<ListState<T>>({ status: "loading" });
  const paramsKey = params ? JSON.stringify(params) : "";

  const fetchList = useCallback(() => {
    apiClient
      .list<T>(resource, params)
      .then((result) => setState({ status: "loaded", result }))
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError
            ? err.message
            : "Couldn't reach the server. Your data is safe — try again.";
        setState({ status: "error", message });
      });
    // paramsKey (not params itself) is the real dependency - params is a
    // fresh object every render otherwise, which would refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, paramsKey]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    fetchList();
  }, [fetchList]);

  return { state, retry };
}
