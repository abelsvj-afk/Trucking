"use client";

// The server's paycheck picture (GET /api/v1/pay-summary), refreshed when
// loads, settlements or duty logs change. Shared by Home's card and
// Money -> Paychecks.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useLiveVersion } from "@/lib/use-live";
import type { PaySummary } from "@/services/api/pay-summary";

export type PaySummaryState = { status: "loading" } | { status: "error" } | { status: "ready"; summary: PaySummary };

export function usePaySummary(): PaySummaryState {
  const version = useLiveVersion(["loads", "duty_logs"]);
  const [state, setState] = useState<PaySummaryState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    apiClient
      .paySummary()
      .then((res) => {
        if (!cancelled) setState({ status: "ready", summary: res.data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [version]);
  return state;
}
