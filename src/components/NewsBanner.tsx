"use client";

// Home News Banner (2026-11-02 design): a slim strip under the Home
// header, rotating the research engine's briefings and "Watching"
// signals - visible proof the engine is alive, with the ages always
// showing. It stays dumb: the server filters the payload, the pure
// builder in lib/news-banner.ts orders the rotation, this component
// renders states and a timer. It never fakes it - and it never goes
// silent: engine off says so (and where to turn it on), a failed load
// says so with a retry, a dead runner gets a warning above the
// rotation, and not-set-up says so instead of inventing headlines.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { buildBannerItems, formatRelativeAge } from "@/lib/news-banner";
import NewsCard from "@/components/NewsCard";
import WordReveal from "@/components/WordReveal";
import { useLiveVersion } from "@/lib/use-live";
import { FEED_OFF_TEXT, FEED_SETUP_TEXT } from "@/lib/feed-status";
import type { ResearchPageData } from "@/types/entities";
import { formatDateTime } from "@/lib/time";

const ROTATE_MS = 6000;
const MANUAL_PAUSE_MS = 12000;
const RESULT_MS = 10000;
const COOLDOWN_FALLBACK_MINUTES = 30;

type LoadPhase =
  | { status: "loading" }
  | { status: "off" }
  | { status: "failed" }
  | { status: "ready"; page: ResearchPageData };

export default function NewsBanner() {
  const [phase, setPhase] = useState<LoadPhase>({ status: "loading" });
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [docHidden, setDocHidden] = useState(false);
  const [reducedMotion, setReducedMotion] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [now, setNow] = useState(() => new Date());
  const [checking, setChecking] = useState(false);
  const [wireResult, setWireResult] = useState<ReactNode | null>(null);
  const [manualHold, setManualHold] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // .then-chain style (the house pattern): state writes land in
  // promise callbacks, never synchronously inside an effect.
  const load = useCallback(
    () =>
      apiClient
        .listResearchBriefings()
        .then((page) => {
          // Deep research off (or unverifiable) says so - a slim muted
          // line, never invented headlines and never a silent absence.
          if (!page.engine_enabled) {
            setPhase({ status: "off" });
            return;
          }
          setPhase({ status: "ready", page });
        })
        .catch(() => {
          // Nothing shown yet (still loading, or a previous failure):
          // say so, with a retry. A failed refresh over a good payload
          // keeps that payload rather than blanking Home. Decided by
          // what is on screen, not by which call this was - the first
          // load can arrive after live events already bumped the version.
          setPhase((prev) => (prev.status === "ready" || prev.status === "off" ? prev : { status: "failed" }));
        }),
    [],
  );

  // Live layer: a new briefing or signal swaps into the rotation on
  // its own (a failed refresh keeps the last good payload).
  const liveVersion = useLiveVersion(["research_briefings", "research_signals"]);
  useEffect(() => {
    void load();
  }, [load, liveVersion]);

  // Safety net for a dropped channel: re-read every 5 minutes while visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5 * 60_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onVisibility = () => setDocHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Ages stay honest while the strip sits open.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const page = phase.status === "ready" ? phase.page : null;
  const items = useMemo(() => (page ? buildBannerItems(page, now) : []), [page, now]);
  const current = items.length > 0 ? items[Math.min(index, items.length - 1)] : null;

  // The rotation timer. The CSS reduced-motion guard cannot stop a
  // JS timer, so the preference is checked here (§3): reduced motion
  // means no timer at all, just the top item and the dots.
  useEffect(() => {
    if (items.length <= 1 || reducedMotion) return;
    const timer = setInterval(() => {
      if (paused || manualHold || docHidden) return;
      setIndex((value) => (value + 1) % items.length);
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, [items.length, paused, manualHold, docHidden, reducedMotion]);

  const showResult = useCallback((node: ReactNode) => {
    setWireResult(node);
    if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
    resultTimerRef.current = setTimeout(() => setWireResult(null), RESULT_MS);
  }, []);

  useEffect(
    () => () => {
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    },
    [],
  );

  async function handleCheckWires() {
    setChecking(true);
    try {
      const res = await apiClient.checkWires();
      if (res.state === "fresh") {
        showResult(
          `${res.new_signals} new item${res.new_signals === 1 ? "" : "s"} on the wires · just now`,
        );
        void load();
      } else if (res.state === "quiet") {
        showResult(
          <>
            Wires are quiet — checked just now.{" "}
            <Link href="/more/research">Want a full deep-dive? Queue one →</Link>
          </>,
        );
        void load();
      } else if (res.state === "cooldown") {
        const ago = res.checked_at
          ? Math.max(1, Math.round((Date.now() - new Date(res.checked_at).getTime()) / 60000))
          : null;
        showResult(
          `Checked ${ago !== null ? `${ago} min ago` : "a few minutes ago"} — next check in ${
            res.next_check_in_minutes ?? COOLDOWN_FALLBACK_MINUTES
          } min`,
        );
      } else {
        showResult(res.reason ?? "The wires couldn't be checked just now.");
      }
    } catch (err: unknown) {
      showResult(
        err instanceof ApiClientError ? err.message : "Couldn't check the wires just now.",
      );
    } finally {
      setChecking(false);
    }
  }

  function retryLoad() {
    setPhase({ status: "loading" });
    void load();
  }

  function stepTo(next: number) {
    setIndex(next);
    // A manual step holds the rotation for 12s (§3) - a timer, not a
    // timestamp, so no impure clock read lives in render scope.
    setManualHold(true);
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => setManualHold(false), MANUAL_PAUSE_MS);
  }

  if (phase.status === "off") {
    return (
      <section aria-label="News" className="news-banner news-banner-muted">
        <p className="news-banner-line">
          {FEED_OFF_TEXT}{" "}
          <Link href="/more/settings/ai">Turn on Deep research in Settings →</Link>
        </p>
      </section>
    );
  }

  if (phase.status === "failed") {
    return (
      <section aria-label="News" className="news-banner news-banner-muted">
        <p className="news-banner-line">
          News unavailable.{" "}
          <button type="button" onClick={retryLoad}>
            Tap to retry
          </button>
        </p>
      </section>
    );
  }

  const setup =
    page !== null && (page.runner === null || page.runner.last_tick_at === null);
  const stale = page !== null && !setup && page.runner?.stale === true;

  return (
    <>
      <section
        aria-label="News"
        className="news-banner"
        onPointerDown={() => setPaused(true)}
        onPointerUp={() => setPaused(false)}
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        {phase.status === "loading" && <p className="news-banner-line">Checking the wires…</p>}

        {page !== null && setup && (
          <>
            <p className="news-banner-line">
              {FEED_SETUP_TEXT}
            </p>
            <p className="news-banner-actions">
              <Link href="/more/research">Open the Research tab →</Link>
            </p>
          </>
        )}

        {page !== null && !setup && (
          <>
            {stale && (
              <p className="news-banner-warning" role="alert">
                ⚠️ Research runner hasn&apos;t checked in since{" "}
                {formatDateTime(page.runner!.last_tick_at!, "America/New_York")} — headlines may be
                behind.
              </p>
            )}

            {current ? (
              <div className="news-banner-item-zone">
                <Link
                  key={`${current.kind}-${current.id}`}
                  href={
                    current.kind === "briefing"
                      ? `/more/research?briefing=${current.id}`
                      : `/more/research?signal=${current.id}`
                  }
                  className="news-banner-item"
                >
                  {/* Phase 4 (owner ruling 2026-11-10): the story renders
                      through the design system's NewsCard — its own image
                      (signals via /api/v1/news-image, briefings via
                      /api/v1/briefing-image), or the branded fallback tile
                      when there is none or it fails to load. Never a bare
                      text row. */}
                  <NewsCard
                    headline={<WordReveal text={current.headline} />}
                    imageSrc={current.imageSrc}
                    topic={current.topic}
                    meta={
                      <span className="news-banner-tagrow">
                        <span>
                          {current.topic.toUpperCase()} · {formatRelativeAge(current.at, now)}
                        </span>
                        {current.kind === "signal" ? (
                          <span className="news-banner-watching">WATCHING</span>
                        ) : current.unread ? (
                          <span className="news-banner-new">● new</span>
                        ) : null}
                      </span>
                    }
                  >
                    {current.sub && <span className="news-banner-sub">{current.sub}</span>}
                  </NewsCard>
                </Link>
              </div>
            ) : (
              <div className="news-banner-item-zone">
                <p className="news-banner-line">The wires are quiet — nothing needs your attention.</p>
                <p className="news-banner-line">
                  Last checked {formatRelativeAge(page.runner!.last_tick_at!, now)}.
                </p>
              </div>
            )}

            {items.length > 1 && (
              <div className="news-banner-dots">
                {items.map((item, itemIndex) => (
                  <button
                    key={`${item.kind}-${item.id}`}
                    type="button"
                    aria-label={`Show item ${itemIndex + 1} of ${items.length}`}
                    aria-current={itemIndex === Math.min(index, items.length - 1)}
                    className={
                      itemIndex === Math.min(index, items.length - 1)
                        ? "news-banner-dot active"
                        : "news-banner-dot"
                    }
                    onClick={() => stepTo(itemIndex)}
                  />
                ))}
              </div>
            )}

            <p className="news-banner-actions">
              <button type="button" onClick={handleCheckWires} disabled={checking}>
                {checking ? "Checking the wires…" : "Check the wires now"}
              </button>
            </p>
          </>
        )}
      </section>

      {wireResult && <p className="news-banner-result">{wireResult}</p>}
    </>
  );
}
