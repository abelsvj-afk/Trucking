"use client";

// Fetch hook for GET /api/v1/duty-logs/window (Reliability Unit B,
// B.2.4) - the HOS summary's dedicated data path: every duty log in
// the carrier-anchored calculation window, ascending, plus the
// server-computed cycle summary. Same shape/discipline as
// lib/use-financial-summary.ts: setState only inside the async
// handlers. An error here is reported as an error - the summary must
// never silently fall back to a truncated list (that was F-013).

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError } from "./api-client";
import { useLiveVersion } from "./use-live";
import type { DutyLog } from "@/types/entities";
import type { DutyLogWindowSummary } from "@/types/hos-settings";

export type HosWindowState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "loaded";
      data: DutyLog[];
      hos: DutyLogWindowSummary;
      /**
       * Stale-data flag (audit D MEDIUM 4): a failed silent refresh
       * keeps the last good data rather than blanking a ticking
       * display - but the display must say so. `staleSinceMs` is
       * when the data stopped being fresh, so the label can carry
       * its age. A successful fetch clears both.
       */
      stale: boolean;
      staleSinceMs: number | null;
    };

export function useHosWindow() {
  const [state, setState] = useState<HosWindowState>({ status: "loading" });

  const fetchWindow = useCallback(() => {
    apiClient
      .dutyLogWindow()
      .then((result) =>
        setState({ status: "loaded", data: result.data, hos: result.hos, stale: false, staleSinceMs: null }),
      )
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again.";
        setState({ status: "error", message });
      });
  }, []);

  // Live layer: any duty-log change re-fetches the window silently.
  const liveVersion = useLiveVersion(["duty_logs"]);

  useEffect(() => {
    fetchWindow();
  }, [fetchWindow, liveVersion]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    fetchWindow();
  }, [fetchWindow]);

  // Silent re-fetch (no loading flash): focus, the 5-minute safety
  // net and after-save refreshes. A failed silent refresh keeps the
  // last good data rather than blanking a ticking display - and marks
  // it stale with its age, so the clocks never present old data as
  // current (audit D MEDIUM 4).
  const refresh = useCallback(() => {
    apiClient
      .dutyLogWindow()
      .then((result) =>
        setState({ status: "loaded", data: result.data, hos: result.hos, stale: false, staleSinceMs: null }),
      )
      .catch(() => {
        setState((prev) =>
          prev.status === "loaded"
            ? { ...prev, stale: true, staleSinceMs: prev.staleSinceMs ?? Date.now() }
            : prev,
        );
      });
  }, []);

  return { state, retry, refresh };
}
