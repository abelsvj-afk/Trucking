"use client";

// Data hook for Money -> Truck Fund (docs/design/driver-mvp.md §9):
// the one aggregate fetch (funds, progress, settings, settled
// periods, suggestion, entries, ladder, account snapshots). Same
// shape/discipline as lib/use-financial-summary.ts: setState only
// happens inside the async .then()/.catch(), never synchronously in
// the effect body. `retry` is also the page's refetch after a write
// (entry logged, suggestion recorded, settings or ladder changed).

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import type { TruckFundOverview } from "@/types/truck-fund";

export type TruckFundState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; overview: TruckFundOverview };

export function useTruckFund() {
  const [state, setState] = useState<TruckFundState>({ status: "loading" });

  const fetchOverview = useCallback(() => {
    apiClient
      .truckFund()
      .then((overview) => setState({ status: "loaded", overview }))
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError ? err.message : "Couldn't load the Truck Fund. Try again.";
        setState({ status: "error", message });
      });
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    fetchOverview();
  }, [fetchOverview]);

  return { state, retry };
}
