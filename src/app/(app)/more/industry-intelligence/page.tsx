"use client";

// Task 4.8 (TASKS.md), per docs/design/ui-ux.md's More > Industry
// intelligence section: a dismissable feed of briefings, each showing the
// shared output contract's summary/reasoning/confidence/based_on, plus a
// service_status banner that only appears once the consecutive-failure
// escalation has actually triggered (docs/automation.md's Human
// escalation - a single failure is routine and silent, several in a row
// is not).

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import type { IndustryBriefing } from "@/types/entities";
import type { ServiceStatus } from "@/types/service-status";

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; briefings: IndustryBriefing[]; serviceStatus: ServiceStatus };

const CONFIDENCE_LABELS: Record<IndustryBriefing["confidence"], string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

export default function IndustryIntelligencePage() {
  usePageTitle("Industry intelligence");
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [dismissing, setDismissing] = useState<string | null>(null);

  const fetchBriefings = useCallback(() => {
    apiClient
      .listIndustryBriefings<IndustryBriefing>()
      .then((result) =>
        setState({ status: "loaded", briefings: result.data, serviceStatus: result.service_status }),
      )
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again.";
        setState({ status: "error", message });
      });
  }, []);

  useEffect(() => {
    fetchBriefings();
  }, [fetchBriefings]);

  async function handleDismiss(id: string) {
    setDismissing(id);
    try {
      await apiClient.dismissIndustryBriefing(id);
      fetchBriefings();
    } finally {
      setDismissing(null);
    }
  }

  return (
    <div>
      <h1>Industry intelligence</h1>

      {state.status === "loaded" && state.serviceStatus.escalated && (
        <p role="alert">
          The industry-intelligence job has failed {state.serviceStatus.consecutive_failures} times in a
          row. It will keep retrying on its normal schedule — no action needed unless this continues.
        </p>
      )}

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={fetchBriefings} />}
      {state.status === "loaded" && state.briefings.length === 0 && (
        <ListEmpty message="No briefings yet. Turn this on in Account & settings to start receiving them." />
      )}
      {state.status === "loaded" && state.briefings.length > 0 && (
        <ul>
          {state.briefings.map((briefing) => (
            <li key={briefing.id}>
              <p>{briefing.summary}</p>
              <p>{briefing.reasoning}</p>
              <p>
                {CONFIDENCE_LABELS[briefing.confidence]} — based on: {briefing.based_on.join(", ")}
              </p>
              <p>{new Date(briefing.generated_at).toLocaleDateString()}</p>
              <button
                type="button"
                onClick={() => handleDismiss(briefing.id)}
                disabled={dismissing === briefing.id}
              >
                {dismissing === briefing.id ? "Dismissing…" : "Dismiss"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
