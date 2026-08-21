"use client";

// Shared fetch hook for the computed /financial-summary endpoint - used by
// both the Home snapshot (no params, current month) and Money > Summary
// (an explicit date range). Same shape/discipline as lib/use-api-list.ts:
// setState only happens inside the async .then()/.catch(), never
// synchronously in the effect body.

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError } from "./api-client";
import type { FinancialSummary } from "@/types/financial-summary";

export type FinancialSummaryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; summary: FinancialSummary };

export function useFinancialSummary(params?: { from: string; to: string }) {
  const [state, setState] = useState<FinancialSummaryState>({ status: "loading" });
  const paramsKey = params ? `${params.from}_${params.to}` : "";

  const fetchSummary = useCallback(() => {
    apiClient
      .financialSummary(params)
      .then((summary) => setState({ status: "loaded", summary }))
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again.";
        setState({ status: "error", message });
      });
    // paramsKey (not params itself) is the real dependency - same reasoning
    // as use-api-list.ts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    fetchSummary();
  }, [fetchSummary]);

  return { state, retry };
}
