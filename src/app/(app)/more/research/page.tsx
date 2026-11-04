"use client";

// Deep Research Engine (docs/design/research-engine.md §5): the
// owner's briefing archive + engine panel. Briefings are stored data
// produced by the pressure-triggered engine - findings with real
// source links, what changed, the counter-move, one takeaway, and the
// unverified items kept visibly separate, never blended into the
// findings. The engine panel makes the autonomy legible: watcher
// health (failures shown, never silent), the recent run log (caps and
// kill-switch skips included), and cap usage.
//
// Home News Banner deep links (2026-11-02 design §6): the Home
// banner links here as ?briefing=<id> / ?signal=<id> - ids only,
// never list positions, so an item stays addressable forever. The
// page spotlights the item, marks a briefing read on open, and, if
// the briefing fell out of the list (he dismissed it earlier),
// fetches it by id and pins it with a plain note.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import { formatRelativeAge } from "@/lib/news-banner";
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
  eia_diesel_regional: "Regional diesel - East/Gulf Coast (EIA)",
  federal_register: "Federal rules (FMCSA)",
  industry_news: "Industry news feeds",
  fred_market: "Markets (FRED)",
  stooq_market: "Markets (Stooq - retired)",
  gdelt_geo: "Overseas & geopolitics (GDELT)",
  nws_weather: "Weather alerts (NWS)",
  openstates: "State laws & weights (OpenStates)",
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

type DeepLinkTarget = { kind: "briefing" | "signal"; id: string };

function BriefingSnapshot({
  briefing,
  busy,
  onRead,
  onDismiss,
  spotlight,
  registerRef,
}: {
  briefing: ResearchBriefing;
  busy: boolean;
  onRead?: (id: string) => void;
  onDismiss?: (id: string) => void;
  spotlight: boolean;
  registerRef: (id: string) => (el: HTMLElement | null) => void;
}) {
  return (
    <li ref={registerRef(briefing.id)} className={spotlight ? "spotlight" : undefined}>
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
      {briefing.sources.length > 0 && (
        <div className="original-sources">
          <p>
            <strong>Original sources</strong>
          </p>
          <ul>
            {briefing.sources.map((source, index) => (
              <li key={index}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {onRead && !briefing.read_at && (
        <button type="button" onClick={() => onRead(briefing.id)} disabled={busy}>
          Mark read
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={() => onDismiss(briefing.id)} disabled={busy}>
          {busy ? "Working…" : "Dismiss"}
        </button>
      )}
    </li>
  );
}

export default function ResearchPage() {
  usePageTitle("Research");
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [queueMessage, setQueueMessage] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);

  // Deep-link state (§6): the target parsed from the URL, the
  // spotlighted item, a dismissed briefing pinned via the by-id
  // fallback, and the plain line when the target isn't available.
  // The target is read once, lazily, from the URL - no markup depends
  // on it during the first render (resolution happens in an effect
  // after the data loads), so server and hydration renders agree.
  const [target] = useState<DeepLinkTarget | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const briefingId = params.get("briefing");
    const signalId = params.get("signal");
    if (briefingId) return { kind: "briefing", id: briefingId };
    if (signalId) return { kind: "signal", id: signalId };
    return null;
  });
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  const [pinnedBriefing, setPinnedBriefing] = useState<ResearchBriefing | null>(null);
  const [targetMissing, setTargetMissing] = useState<string | null>(null);
  const targetHandledRef = useRef(false);
  const itemRefs = useRef(new Map<string, HTMLElement>());

  const registerRef = useCallback(
    (id: string) =>
      (el: HTMLElement | null) => {
        if (el) itemRefs.current.set(id, el);
        else itemRefs.current.delete(id);
      },
    [],
  );

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

  const scrollToItem = useCallback((id: string) => {
    itemRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Spotlight fades after ~4s or on the first tap/click anywhere.
  useEffect(() => {
    if (!spotlightId) return;
    const timer = setTimeout(() => setSpotlightId(null), 4000);
    const clear = () => setSpotlightId(null);
    window.addEventListener("pointerdown", clear, { once: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", clear);
    };
  }, [spotlightId]);

  // Resolve the deep link once the page data is in (§6.2/§6.4/§6.5).
  // All state writes happen in the async continuation / promise
  // callbacks, never synchronously in the effect body.
  useEffect(() => {
    if (state.status !== "loaded" || !target || targetHandledRef.current) return;
    targetHandledRef.current = true;
    const page = state.page;
    let cancelled = false;

    void (async () => {
      await Promise.resolve();
      if (cancelled) return;

      if (target.kind === "signal") {
        const found = page.signals.some((signal) => signal.id === target.id);
        if (found) {
          setSpotlightId(target.id);
          scrollToItem(target.id);
        } else {
          setTargetMissing("That wire item isn't current anymore - what's live is below.");
        }
        return;
      }

      const briefing = page.data.find((item) => item.id === target.id);
      if (briefing) {
        setSpotlightId(briefing.id);
        scrollToItem(briefing.id);
        // Opening from the banner is reading it in full - leaving it
        // "unread" would be a false state.
        if (!briefing.read_at) {
          void apiClient
            .markResearchBriefingRead(briefing.id)
            .then(() => fetchPage())
            .catch(() => undefined);
        }
        return;
      }

      // Not in the list - the realistic case is an earlier dismissal.
      const found = await apiClient.getResearchBriefing(target.id).catch(() => null);
      if (cancelled) return;
      if (found) {
        setPinnedBriefing(found);
        setSpotlightId(found.id);
      } else {
        setTargetMissing("That briefing isn't available anymore.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state, target, fetchPage, scrollToItem]);

  // The pinned fallback renders after the resolution above lands;
  // scroll to it once it exists in the DOM (a DOM write, no state).
  useEffect(() => {
    if (!pinnedBriefing) return;
    scrollToItem(pinnedBriefing.id);
  }, [pinnedBriefing, scrollToItem]);

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
          {state.page.runner?.stale && (
            <p role="alert">
              ⚠️ The research runner hasn&apos;t ticked
              {state.page.runner.last_tick_at
                ? ` since ${new Date(state.page.runner.last_tick_at).toLocaleString()}`
                : " yet"}
              {" "}— briefings may be behind. The watchdog also flags this on Telegram.
            </p>
          )}
          {state.page.runner && !state.page.runner.stale && state.page.runner.last_tick_at && (
            <p>
              Runner last ticked {new Date(state.page.runner.last_tick_at).toLocaleString()}
              {state.page.runner.last_source && ` (via ${state.page.runner.last_source})`}.
            </p>
          )}
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

          {state.page.signals.length > 0 && (
            <>
              <h2>On the wires</h2>
              <p>Raw pressure the watchers are seeing. Not briefings yet.</p>
              <ul>
                {state.page.signals.map((signal) => (
                  <li
                    key={signal.id}
                    ref={registerRef(signal.id)}
                    className={spotlightId === signal.id ? "spotlight" : undefined}
                  >
                    <p>
                      <strong>{signal.summary}</strong>
                    </p>
                    <p>
                      Topic: {signal.topic} ·{" "}
                      {WATCHER_LABELS[signal.watcher_key] ?? signal.watcher_key} ·{" "}
                      {formatRelativeAge(signal.observed_at)}
                    </p>
                    <p>Not a briefing yet — this is raw pressure the watchers are seeing.</p>
                    {signal.items.length > 0 && (
                      <ul>
                        {signal.items.map((item, index) => (
                          <li key={index}>
                            <a href={item.url} target="_blank" rel="noreferrer">
                              {item.title}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2>
            Briefings{state.page.unread_count > 0 && ` (${state.page.unread_count} unread)`}
          </h2>
          {targetMissing && <p>{targetMissing}</p>}
          {pinnedBriefing && (
            <>
              <p>You dismissed this one earlier — here&apos;s the full briefing.</p>
              <ul>
                <BriefingSnapshot
                  briefing={pinnedBriefing}
                  busy={busyId === pinnedBriefing.id}
                  onRead={handleRead}
                  spotlight={spotlightId === pinnedBriefing.id}
                  registerRef={registerRef}
                />
              </ul>
            </>
          )}
          {state.page.data.length === 0 && !pinnedBriefing && (
            <ListEmpty message="No briefings yet. The engine writes its first one at the next pressure trigger or baseline run - or queue a topic above." />
          )}
          {state.page.data.length > 0 && (
            <ul>
              {state.page.data.map((briefing) => (
                <BriefingSnapshot
                  key={briefing.id}
                  briefing={briefing}
                  busy={busyId === briefing.id}
                  onRead={handleRead}
                  onDismiss={handleDismiss}
                  spotlight={spotlightId === briefing.id}
                  registerRef={registerRef}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
