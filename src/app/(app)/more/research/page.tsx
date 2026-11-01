"use client";

// Deep Research Engine (docs/design/research-engine.md §5): the
// owner's briefing archive + engine panel. Briefings are stored data
// produced by the pressure-triggered engine - findings with real
// source links, what changed, the counter-move, one takeaway, and the
// unverified items kept visibly separate, never blended into the
// findings. The engine panel makes the autonomy legible: watcher
// health (failures shown, never silent), the recent run log (caps and
// kill-switch skips included), and cap usage.

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import type { ResearchBriefing, ResearchPageData } from "@/types/entities";

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; page: ResearchPageData };

const CONFIDENCE_LABELS: Record<ResearchBriefing["confidence"], string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const WATCHER_LABELS: Record<string, string> = {
  eia_diesel: "Diesel prices (EIA)",
  federal_register: "Federal rules (FMCSA)",
  industry_news: "Industry news feeds",
};

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  success: "Briefing produced",
  failure: "Failed",
  insufficient_data: "Not enough data",
  skipped_cap: "Skipped - run cap reached",
  skipped_disabled: "Skipped - engine off",
};

export default function ResearchPage() {
  usePageTitle("Research");
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [queueMessage, setQueueMessage] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);

  const fetchPage = useCallback(() => {
    apiClient
      .listResearchBriefings()
      .then((page) => setState({ status: "loaded", page }))
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again.";
        setState({ status: "error", message });
      });
  }, []);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  async function handleRead(id: string) {
    setBusyId(id);
    try {
      await apiClient.markResearchBriefingRead(id);
      fetchPage();
    } finally {
      setBusyId(null);
    }
  }

  async function handleDismiss(id: string) {
    setBusyId(id);
    try {
      await apiClient.dismissResearchBriefing(id);
      fetchPage();
    } finally {
      setBusyId(null);
    }
  }

  async function handleResearchNow(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = topic.trim();
    if (trimmed.length < 3) return;
    setQueueing(true);
    setQueueMessage(null);
    try {
      await apiClient.researchNow(trimmed);
      setTopic("");
      setQueueMessage(
        "Queued. The engine will run it on its next check-in - subject to the run caps and the Deep research switch in Settings.",
      );
      fetchPage();
    } catch (err: unknown) {
      setQueueMessage(
        err instanceof ApiClientError ? err.message : "Couldn't queue that. Try again.",
      );
    } finally {
      setQueueing(false);
    }
  }

  return (
    <div>
      <h1>Research</h1>
      <p>
        The deep research engine watches fuel prices, federal trucking rules, and industry news.
        When pressure hits - or on its twice-a-month baseline - it writes you a briefing with
        sources and one thing to do about it. Turn it on in Account &amp; settings → Deep research
        engine.
      </p>

      <form onSubmit={handleResearchNow}>
        <label htmlFor="research-topic">Research this now</label>
        <input
          id="research-topic"
          type="text"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          placeholder="e.g. factoring costs for a brand-new authority"
          maxLength={200}
        />
        <button type="submit" disabled={queueing || topic.trim().length < 3}>
          {queueing ? "Queueing…" : "Queue research"}
        </button>
        {queueMessage && <p>{queueMessage}</p>}
      </form>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={fetchPage} />}

      {state.status === "loaded" && (
        <>
          <h2>Engine</h2>
          <p>
            Runs used: {state.page.usage.runs_today}/{state.page.usage.max_runs_per_day} today,{" "}
            {state.page.usage.runs_this_month}/{state.page.usage.max_runs_per_month} this month
            (hard caps - a capped run is logged below, never silent).
          </p>
          {state.page.watchers.length > 0 && (
            <ul>
              {state.page.watchers.map((watcher) => (
                <li key={watcher.watcher_key}>
                  {WATCHER_LABELS[watcher.watcher_key] ?? watcher.watcher_key}:{" "}
                  {watcher.last_status ?? "not polled yet"}
                  {watcher.last_polled_at &&
                    ` - last checked ${new Date(watcher.last_polled_at).toLocaleString()}`}
                  {watcher.last_error && ` - ${watcher.last_error}`}
                </li>
              ))}
            </ul>
          )}
          {state.page.runs.length > 0 && (
            <>
              <h3>Recent runs</h3>
              <ul>
                {state.page.runs.map((run) => (
                  <li key={run.id}>
                    {RUN_STATUS_LABELS[run.status] ?? run.status} - {run.topic} ({run.trigger_kind},{" "}
                    {new Date(run.created_at).toLocaleString()})
                    {run.error_message && ` - ${run.error_message}`}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2>
            Briefings{state.page.unread_count > 0 && ` (${state.page.unread_count} unread)`}
          </h2>
          {state.page.data.length === 0 && (
            <ListEmpty message="No briefings yet. The engine writes its first one at the next pressure trigger or baseline run - or queue a topic above." />
          )}
          {state.page.data.length > 0 && (
            <ul>
              {state.page.data.map((briefing) => (
                <li key={briefing.id}>
                  <p>
                    {!briefing.read_at && <strong>● New - </strong>}
                    <strong>{briefing.title}</strong>
                  </p>
                  <p>{briefing.headline}</p>
                  <p>
                    Topic: {briefing.topic} · {CONFIDENCE_LABELS[briefing.confidence]} ·{" "}
                    {new Date(briefing.created_at).toLocaleString()}
                    {briefing.telegram_notified_at && " · sent to Telegram"}
                  </p>
                  <ul>
                    {briefing.findings.map((finding, index) => (
                      <li key={index}>
                        {finding.claim} (
                        <a href={finding.source_url} target="_blank" rel="noreferrer">
                          {finding.source_title}
                        </a>
                        )
                      </li>
                    ))}
                  </ul>
                  <p>
                    <strong>What changed:</strong> {briefing.what_changed}
                  </p>
                  <p>
                    <strong>Counter-move:</strong> {briefing.counter_move}
                  </p>
                  <p>
                    <strong>Takeaway:</strong> {briefing.takeaway}
                  </p>
                  {briefing.unverified.length > 0 && (
                    <>
                      <p>
                        <strong>Not verified (treat with care):</strong>
                      </p>
                      <ul>
                        {briefing.unverified.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {!briefing.read_at && (
                    <button
                      type="button"
                      onClick={() => handleRead(briefing.id)}
                      disabled={busyId === briefing.id}
                    >
                      Mark read
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDismiss(briefing.id)}
                    disabled={busyId === briefing.id}
                  >
                    {busyId === briefing.id ? "Working…" : "Dismiss"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
