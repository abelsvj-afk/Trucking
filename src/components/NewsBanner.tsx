"use client";

// Home News Banner (2026-11-02 design): a slim strip under the Home
// header, rotating the research engine's briefings and "Watching"
// signals - visible proof the engine is alive, with the ages always
// showing. It stays dumb: the server filters the payload, the pure
// builder in lib/news-banner.ts orders the rotation, this component
// renders states and a timer. It never fakes it - engine off means
// no strip at all, a dead runner gets a warning above the rotation,
// and not-set-up says so instead of inventing headlines.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { buildBannerItems, formatRelativeAge } from "@/lib/news-banner";
import { topicEmoji } from "@/lib/research-topics";
import type { ResearchPageData } from "@/types/entities";

const ROTATE_MS = 6000;
const MANUAL_PAUSE_MS = 12000;
const RESULT_MS = 10000;
const COOLDOWN_FALLBACK_MINUTES = 30;

type LoadPhase = { status: "loading" } | { status: "hidden" } | { status: "ready"; page: ResearchPageData };

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
    (initial: boolean) =>
      apiClient
        .listResearchBriefings()
        .then((page) => {
          // Deep research off (or unverifiable) = no strip at all (§7).
          if (!page.engine_enabled) {
            setPhase({ status: "hidden" });
            return;
          }
          setPhase({ status: "ready", page });
        })
        .catch(() => {
          // Fail closed on the first load; a failed refresh keeps
          // the last good payload rather than blanking Home.
          if (initial) setPhase({ status: "hidden" });
        }),
    [],
  );

  useEffect(() => {
    void load(true);
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
        void load(false);
      } else if (res.state === "quiet") {
        showResult(
          <>
            Wires are quiet — checked just now.{" "}
            <Link href="/more/research">
              Want a full deep-dive? Queue one{" "}
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" className="inline-action-icon" />
            </Link>
          </>,
        );
        void load(false);
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

  function stepTo(next: number) {
    setIndex(next);
    // A manual step holds the rotation for 12s (§3) - a timer, not a
    // timestamp, so no impure clock read lives in render scope.
    setManualHold(true);
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => setManualHold(false), MANUAL_PAUSE_MS);
  }

  if (phase.status === "hidden") return null;

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
              The research engine hasn&apos;t run yet — it needs its one-time setup before
              headlines appear.
            </p>
            <p className="news-banner-actions">
              <Link href="/more/research">
                Open the Research tab{" "}
                <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" className="inline-action-icon" />
              </Link>
            </p>
          </>
        )}

        {page !== null && !setup && (
          <>
            {stale && (
              <p className="news-banner-warning" role="alert">
                ⚠️ Research runner hasn&apos;t checked in since{" "}
                {new Date(page.runner!.last_tick_at!).toLocaleString()} — headlines may be
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
                  <span className="news-banner-tagrow">
                    <span>
                      {topicEmoji(current.topic)} {current.topic.toUpperCase()} ·{" "}
                      {formatRelativeAge(current.at, now)}
                    </span>
                    {current.kind === "signal" ? (
                      <span className="news-banner-watching">WATCHING</span>
                    ) : current.unread ? (
                      <span className="news-banner-new">● new</span>
                    ) : null}
                  </span>
                  <span className="news-banner-headline">{current.headline}</span>
                  {current.sub && <span className="news-banner-sub">{current.sub}</span>}
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
