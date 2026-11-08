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
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import WordReveal from "@/components/WordReveal";
import { usePageTitle } from "@/lib/use-page-title";
import { feedStatus, type FeedStatus } from "@/lib/feed-status";
import Link from "next/link";
import type { IndustryBriefing, ResearchPageData } from "@/types/entities";
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
  // The SAME feed status Home's news strip shows (lib/feed-status.ts decides it once), so the two screens cannot disagree.
  const [feeds, setFeeds] = useState<FeedStatus | null>(null);
  useEffect(() => {
    apiClient
      .listResearchBriefings()
      .then((page: ResearchPageData) => setFeeds(feedStatus(page)))
      .catch(() => setFeeds(feedStatus(null)));
  }, []);

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
      <PageHeader title="Industry intelligence" purpose="Briefings on fuel prices, rule changes, and the freight market — with the reasoning shown, so you can judge them." />

      {feeds && (
        <p role="status" data-feed-state={feeds.state}>
          <strong>News feeds:</strong> {feeds.text}{" "}
          <Link href="/more/research">Details on the Research tab →</Link>
        </p>
      )}

      {state.status === "loaded" && state.serviceStatus.escalated && (
        <p role="alert">
          The industry-intelligence job has failed {state.serviceStatus.consecutive_failures} times in a
          row. It will keep retrying on its normal schedule — no action needed unless this continues.
        </p>
      )}

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={fetchBriefings} />}
      {state.status === "loaded" && state.briefings.length === 0 && (
        <TeachingEmpty
          title="No briefings yet"
          message="When this is on, briefings land here — fuel-price moves, rule changes, market shifts, each with its reasoning shown. Turn it on under More → Account & settings if it is off."
        />
      )}
      {state.status === "loaded" && state.briefings.length > 0 && (
        <ul>
          {state.briefings.map((briefing) => (
            <li key={briefing.id}>
              <p>
                <WordReveal text={briefing.summary} />
              </p>
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
