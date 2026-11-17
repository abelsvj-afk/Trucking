"use client";

// Smart Path v2 (docs/design/smart-path-v2.md, owner order 2026-11-17). It plans the run the moment the page
// opens, from what the app already knows - the active load, which stop is next, where the truck is, the stops'
// appointments, his hours - so there is no form to fill. One screen: the answer on top, the map, four key facts,
// a short timeline, and everything else folded under Details. "Change" re-plans another load, another start
// time, or with different preferences (remembered on this phone). Times are shown in his zone, never UTC.

import dynamic from "next/dynamic";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ACTIVE_PLAN_STORAGE_KEY, serializeActivePlan } from "@/lib/drive-review";
import { DRIVE_COPY } from "@/lib/drive";
import { usePageTitle } from "@/lib/use-page-title";
import { routeCaption } from "@/lib/smart-path";
import { buildMapStops } from "@/lib/smart-path-map-stops";
import { keyFacts, timeline } from "@/lib/smart-path-summary";
import type { AutoPrefs } from "@/lib/smart-path-auto";
import type { AutoRunResult } from "@/services/smart-path/auto";
import SmartPathDetails from "@/components/smart-path/SmartPathDetails";

const SmartPathMap = dynamic(() => import("@/components/SmartPathMap"), { ssr: false });

const PREFS_KEY = "trucking.smartpath.prefs.v2";
const VERDICT: Record<string, { word: string; tone: string }> = {
  on_time: { word: "ON TIME", tone: "ok" },
  early: { word: "EARLY", tone: "ok" },
  late: { word: "LATE", tone: "warn" },
  not_legal: { word: "NOT LEGAL AS PLANNED", tone: "bad" },
};

type Run =
  | { status: "working"; step: string }
  | { status: "error"; message: string }
  | { status: "done"; out: AutoRunResult };

function readPrefs(): AutoPrefs {
  try {
    return JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as AutoPrefs;
  } catch {
    return {};
  }
}

function devicePosition(): Promise<{ lat: number; lng: number; heading: number | null; speed_mph: number | null } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          heading: p.coords.heading !== null && Number.isFinite(p.coords.heading) ? p.coords.heading : null,
          speed_mph: p.coords.speed !== null && Number.isFinite(p.coords.speed) ? Math.min(150, p.coords.speed * 2.23694) : null,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60_000 },
    );
  });
}

/** The server's reason in plain words: the map/route services being unreachable is said as such, not as code. */
function plainError(err: unknown): string {
  const raw = err instanceof ApiClientError ? err.message : "";
  if (/geocod/i.test(raw) && /unreachable|fetch failed|unavailable/i.test(raw)) {
    return "The map lookup service isn't answering right now, so the run can't be placed on the map. Try again in a minute.";
  }
  if (/routing/i.test(raw) && /unreachable|unavailable/i.test(raw)) {
    return "The routing service isn't answering right now, so no route could be drawn. Try again in a minute.";
  }
  return raw || "Smart Path couldn't plan the run. Try again.";
}

interface PlanOpts {
  loadId: string | null;
  leaveAt: string;
  prefs: AutoPrefs;
}

/** Plans the run (this phone's fix, then the server's automatic planner). Never throws: failure is a Run too. */
async function fetchPlan(opts: PlanOpts): Promise<Run> {
  const position = await devicePosition();
  try {
    const body: Record<string, unknown> = { prefs: opts.prefs, position };
    if (opts.loadId) body.load_id = opts.loadId;
    if (opts.leaveAt) body.depart_at = new Date(opts.leaveAt).toISOString();
    const res = await apiClient.create<{ data: AutoRunResult }>("smart-path/auto", body);
    if (res.data.result) {
      try {
        // Drive Mode reads the checked plan from here (Home's GO card and the Drive surface).
        window.localStorage.setItem(ACTIVE_PLAN_STORAGE_KEY, serializeActivePlan(res.data.result, Date.now()));
      } catch {
        /* storage is a nicety; the plan stands */
      }
    }
    return { status: "done", out: res.data };
  } catch (err) {
    return { status: "error", message: plainError(err) };
  }
}

export default function SmartPathPage() {
  return (
    <Suspense fallback={null}>
      <SmartPathInner />
    </Suspense>
  );
}

function SmartPathInner() {
  usePageTitle("Smart Path");
  const params = useSearchParams();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  const [run, setRun] = useState<Run>({ status: "working", step: "Finding where you are…" });
  const [loadId, setLoadId] = useState<string | null>(params.get("load_id"));
  const [leaveAt, setLeaveAt] = useState("");
  const [prefs, setPrefs] = useState<AutoPrefs>(() => (typeof window === "undefined" ? {} : readPrefs()));
  const [showChange, setShowChange] = useState(false);

  // Re-plan on request (Change / Re-check / Try again): announce, then fetch.
  const plan = useCallback((opts: PlanOpts) => {
    setRun({ status: "working", step: "Finding where you are…" });
    void fetchPlan(opts).then(setRun);
  }, []);

  // Plan the moment the page opens - nothing to fill in first. (The state already says "working".)
  useEffect(() => {
    let cancelled = false;
    void fetchPlan({ loadId: params.get("load_id"), leaveAt: "", prefs: readPrefs() }).then((r) => {
      if (!cancelled) setRun(r);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* remembered next time if storage allows */
    }
    setShowChange(false);
    plan({ loadId, leaveAt, prefs });
  }

  const result = run.status === "done" ? run.out.result : null;
  const facts = useMemo(() => (result ? keyFacts(result, zone) : []), [result, zone]);
  const steps = useMemo(() => (result ? timeline(result, zone) : []), [result, zone]);
  const mapStops = useMemo(() => (result ? buildMapStops(result, { workoutSetting: prefs.workout?.setting }) : []), [result, prefs.workout?.setting]);
  const verdict = result ? (VERDICT[result.verdict.status] ?? { word: result.verdict.status, tone: "warn" }) : null;
  const why = result ? (result.verdict.tradeoffLines[0] ?? result.verdict.legalLines[0] ?? "") : "";

  return (
    <div className="smart-path-v2">
      {/* 1. The answer - always the first thing on the screen, including while it works and when it fails. */}
      <section className={`sp-status sp-${verdict?.tone ?? "neutral"}`} aria-live="polite" aria-label="Smart Path answer">
        {run.status === "working" && (
          <>
            <p className="sp-word">Working…</p>
            <p>{run.step}</p>
          </>
        )}
        {run.status === "error" && (
          <>
            <p className="sp-word">Couldn&apos;t plan it</p>
            <p>{run.message}</p>
          </>
        )}
        {run.status === "done" && !result && (
          <>
            <p className="sp-word">Nothing to plan</p>
            {run.out.assumptions.map((a) => <p key={a}>{a}</p>)}
            {run.out.phase === "no_load" && <Link href="/loads/new" className="page-action">Add a load</Link>}
          </>
        )}
        {result && verdict && (
          <>
            <p className="sp-load">{run.status === "done" ? run.out.load?.label : ""}</p>
            <p className="sp-word">{verdict.word}</p>
            {why && <p className="sp-why">{why}</p>}
            {run.status === "done" && <p className="sp-assume">{run.out.assumptions.join(" ")}</p>}
          </>
        )}
        <div className="sp-actions">
          <button type="button" className="secondary" onClick={() => setShowChange((v) => !v)} aria-expanded={showChange}>
            Change
          </button>
          {run.status !== "working" && (
            <button type="button" className={run.status === "error" ? undefined : "secondary"} onClick={() => plan({ loadId, leaveAt, prefs })}>
              {run.status === "error" ? "Try again" : "Re-check"}
            </button>
          )}
          {result &&
            (result.route.truckLegal ? (
              <Link href="/smart-path/drive" className="sp-go">GO — drive it</Link>
            ) : (
              <span className="row-sub">{DRIVE_COPY.carRouteRefusal}</span>
            ))}
        </div>
      </section>

      {showChange && (
        <form className="sp-change" onSubmit={apply} aria-label="Change the plan">
          {run.status === "done" && run.out.choices.length > 0 && (
            <label className="form-row">
              Load
              <select value={loadId ?? ""} onChange={(e) => setLoadId(e.target.value || null)}>
                <option value="">My current load (automatic)</option>
                {run.out.choices.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </label>
          )}
          <label className="form-row">
            Leave
            <input type="datetime-local" value={leaveAt} onChange={(e) => setLeaveAt(e.target.value)} aria-describedby="sp-leave-hint" />
          </label>
          <p id="sp-leave-hint" className="row-sub">Blank = leaving now.</p>
          <label className="form-row">
            Food
            <select value={prefs.food_mode ?? "grocery"} onChange={(e) => setPrefs({ ...prefs, food_mode: e.target.value as AutoPrefs["food_mode"] })}>
              <option value="grocery">Grocery (cook in the truck)</option>
              <option value="fast_food">Fast food</option>
            </select>
          </label>
          <label className="form-row">
            Sleep from
            <select
              value={prefs.sleep_start_hour ?? ""}
              onChange={(e) => setPrefs({ ...prefs, sleep_start_hour: e.target.value === "" ? undefined : Number(e.target.value) })}
            >
              <option value="">No set time</option>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h % 12 === 0 ? 12 : h % 12} {h < 12 ? "AM" : "PM"}</option>)}
            </select>
          </label>
          <label className="form-row">
            Sleep until
            <select
              value={prefs.sleep_end_hour ?? ""}
              onChange={(e) => setPrefs({ ...prefs, sleep_end_hour: e.target.value === "" ? undefined : Number(e.target.value) })}
            >
              <option value="">No set time</option>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h % 12 === 0 ? 12 : h % 12} {h < 12 ? "AM" : "PM"}</option>)}
            </select>
          </label>
          <label className="form-row sp-check">
            <input
              type="checkbox"
              checked={Boolean(prefs.workout?.want)}
              onChange={(e) => setPrefs({ ...prefs, workout: { ...(prefs.workout ?? {}), want: e.target.checked } })}
            />
            Fit a workout in (gym if one is near)
          </label>
          <button type="submit">Plan it</button>
          <p className="row-sub">Food, sleep and workout are remembered on this phone.</p>
        </form>
      )}

      {/* 2. The map. */}
      <SmartPathMap
        geometry={result?.route.geometry ?? []}
        stops={mapStops}
        deadheadGeometry={result?.deadhead?.geometry ?? []}
        caption={`Map © OpenStreetMap contributors.${result ? (result.route.truckLegal ? " Truck-checked route." : " Car route - NOT truck-checked.") : ""}`}
      />

      {/* 3. Four key facts. */}
      {facts.length > 0 && (
        <ul className="sp-facts" aria-label="Key facts">
          {facts.map((f) => (
            <li key={f.label}>
              <span className="sp-fact-label">{f.label}</span>
              <strong>{f.value}</strong>
              {f.sub && <span className="row-sub">{f.sub}</span>}
            </li>
          ))}
        </ul>
      )}

      {/* 4. The run, one line per stop. */}
      {steps.length > 0 && (
        <section aria-label="The run">
          <h2>The run</h2>
          <ol className="sp-timeline">
            {steps.map((s) => (
              <li key={s.text}>
                <span aria-hidden="true">{s.icon}</span> {s.text}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 5. Everything else, folded. */}
      {result && (
        <details className="sp-details">
          <summary>
            Details — hours math, fuel ranking, weather, road work, state rules
            {result.warnings.length > 0 ? ` · ${result.warnings.length} notes` : ""}
          </summary>
          <p className="row-sub">{routeCaption(result.route)}</p>
          <SmartPathDetails result={result} />
        </details>
      )}
    </div>
  );
}
