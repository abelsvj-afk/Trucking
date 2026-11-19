"use client";

// Smart Path v2 (docs/design/smart-path-v2.md, owner order 2026-11-17). It plans the run the moment the page
// opens, from what the app already knows - the active load, which stop is next, where the truck is, the stops'
// appointments, his hours - so there is no form to fill. One screen: the answer on top, the map, four key facts,
// a short timeline, and everything else folded under Details. "Change" re-plans another load, another start
// time, or with different preferences (remembered on this phone). Times are shown in his zone, never UTC.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useNowTick } from "@/lib/use-now-tick";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ACTIVE_PLAN_STORAGE_KEY, serializeActivePlan } from "@/lib/drive-review";
import { DRIVE_COPY } from "@/lib/drive";
import { usePageTitle } from "@/lib/use-page-title";
import { routeCaption, pointAlongRoute } from "@/lib/smart-path";
import { buildMapStops } from "@/lib/smart-path-map-stops";
import { hoursLine, keyFacts, timeline } from "@/lib/smart-path-summary";
import type { AutoPrefs } from "@/lib/smart-path-auto";
import type { AutoRunResult } from "@/services/smart-path/auto";
import SmartPathDetails from "@/components/smart-path/SmartPathDetails";
import type { SmartPathMapHazard } from "@/components/SmartPathMap";

const SmartPathMap = dynamic(() => import("@/components/SmartPathMap"), { ssr: false });

const PREFS_KEY = "trucking.smartpath.prefs.v2";
/** His ELD's clocks, as he entered them (owner 2026-11-17). Used for 14 hours, counted down by the server. */
const ELD_KEY = "trucking.smartpath.eld-clocks.v1";
const ELD_MAX_AGE_MS = 14 * 3_600_000;

interface EldClocks {
  drive_left_min: number;
  window_left_min: number;
  cycle_left_min: number;
  entered_at: string;
}

function readEld(): EldClocks | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(ELD_KEY) ?? "null") as EldClocks | null;
    return v && Date.now() - Date.parse(v.entered_at) < ELD_MAX_AGE_MS ? v : null;
  } catch {
    return null;
  }
}

/** "10:30", "10.5" or "10" (hours) -> minutes; null when blank or unreadable. */
function toMinutes(text: string, maxH: number): number | null {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  const mins = m ? Number(m[1]) * 60 + Number(m[2] ?? 0) : Math.round(Number.parseFloat(t) * 60);
  return Number.isFinite(mins) && mins >= 0 && mins <= maxH * 60 ? mins : null;
}
const hmText = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
const VERDICT: Record<string, { word: string; tone: string }> = {
  on_time: { word: "ON TIME", tone: "ok" },
  early: { word: "EARLY", tone: "ok" },
  late: { word: "LATE", tone: "warn" },
  not_legal: { word: "NOT LEGAL AS PLANNED", tone: "bad" },
};

type Run =
  | { status: "working"; step: string }
  | { status: "error"; message: string }
  | { status: "done"; out: AutoRunResult; savedAtMs?: number };

// The last plan, kept on this phone (owner 2026-11-19: "smart path doesn't
// persist when switching screens"). Coming back shows it at once; it is
// re-checked in the background only when older than RECHECK_AFTER_MS, and
// it is never shown for a different load than the one asked for.
const LAST_RUN_KEY = "trucking.smartpath.last-run.v1";
const RECHECK_AFTER_MS = 15 * 60_000;
const KEEP_FOR_MS = 12 * 60 * 60_000;

function readLastRun(loadId: string | null): { out: AutoRunResult; savedAtMs: number } | null {
  try {
    const raw = window.localStorage.getItem(LAST_RUN_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { out: AutoRunResult; savedAtMs: number; loadId: string | null };
    if (!saved?.out || !Number.isFinite(saved.savedAtMs) || Date.now() - saved.savedAtMs > KEEP_FOR_MS) return null;
    if (loadId && saved.loadId !== loadId) return null;
    return { out: saved.out, savedAtMs: saved.savedAtMs };
  } catch {
    return null;
  }
}

function saveLastRun(out: AutoRunResult, loadId: string | null): void {
  try {
    window.localStorage.setItem(LAST_RUN_KEY, JSON.stringify({ out, savedAtMs: Date.now(), loadId }));
  } catch {
    /* storage refused: it just re-plans next time */
  }
}

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
    const eld = readEld();
    if (eld) body.eld_clocks = eld;
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
    saveLastRun(res.data, opts.loadId);
    return { status: "done", out: res.data, savedAtMs: Date.now() };
  } catch (err) {
    return { status: "error", message: plainError(err) };
  }
}

function planAge(savedAtMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - savedAtMs) / 60_000));
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
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
  const [eldText, setEldText] = useState(() => {
    const e = typeof window === "undefined" ? null : readEld();
    return e ? { drive: hmText(e.drive_left_min), shift: hmText(e.window_left_min), cycle: hmText(e.cycle_left_min) } : { drive: "", shift: "", cycle: "" };
  });
  const [eldError, setEldError] = useState<string | null>(null);

  // Re-plan on request (Change / Re-check / Try again): announce, then fetch.
  const plan = useCallback((opts: PlanOpts) => {
    setRun({ status: "working", step: "Finding where you are…" });
    void fetchPlan(opts).then(setRun);
  }, []);

  // Plan the moment the page opens - nothing to fill in first. Coming back
  // to the page shows the last plan at once; it is re-checked quietly only
  // when it is older than 15 minutes (and a failed quiet re-check keeps it).
  useEffect(() => {
    let cancelled = false;
    const last = readLastRun(params.get("load_id"));
    // Show the kept plan at once (after hydration, so server and phone agree on first paint).
    if (last) queueMicrotask(() => !cancelled && setRun({ status: "done", out: last.out, savedAtMs: last.savedAtMs }));
    if (last && Date.now() - last.savedAtMs < RECHECK_AFTER_MS) return () => {
      cancelled = true;
    };
    void fetchPlan({ loadId: params.get("load_id"), leaveAt: "", prefs: readPrefs() }).then((r) => {
      if (cancelled) return;
      if (r.status === "error" && last) return;
      setRun(r);
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
    // ELD hours: all three filled = use them; all blank = back to the app log; anything else = say what's wrong.
    const drive = toMinutes(eldText.drive, 11);
    const shift = toMinutes(eldText.shift, 14);
    const cycle = toMinutes(eldText.cycle, 70);
    const anyTyped = [eldText.drive, eldText.shift, eldText.cycle].some((v) => v.trim() !== "");
    try {
      if (drive !== null && shift !== null && cycle !== null) {
        window.localStorage.setItem(ELD_KEY, JSON.stringify({ drive_left_min: drive, window_left_min: shift, cycle_left_min: cycle, entered_at: new Date().toISOString() }));
      } else if (!anyTyped) {
        window.localStorage.removeItem(ELD_KEY);
      } else {
        setEldError("Fill in all three ELD hours (like 10:30), or clear all three to use the app's log.");
        setShowChange(true);
        return;
      }
    } catch {
      /* storage refused - the plan still runs on the app log */
    }
    setEldError(null);
    plan({ loadId, leaveAt, prefs });
  }

  const nowTick = useNowTick(30_000);
  const result = run.status === "done" ? run.out.result : null;
  const facts = useMemo(() => (result ? keyFacts(result, zone) : []), [result, zone]);
  const steps = useMemo(() => (result ? timeline(result, zone) : []), [result, zone]);
  const mapStops = useMemo(() => (result ? buildMapStops(result, { workoutSetting: prefs.workout?.setting }) : []), [result, prefs.workout?.setting]);
  // Live awareness: the colored stretches straight from the check,
  // and a marker for each delay and each bridge that isn't a clear
  // pass (minor delays are listed in Details, not marked).
  const mapSegments = useMemo(() => result?.traffic?.segments ?? [], [result]);
  const mapHazards = useMemo((): SmartPathMapHazard[] => {
    if (!result) return [];
    const totalMiles = result.route.distanceMiles;
    const geo = result.route.geometry;
    const out: SmartPathMapHazard[] = [];
    for (const item of result.traffic?.items ?? []) {
      if (item.severity === "minor") continue;
      const point = pointAlongRoute(geo, totalMiles > 0 ? item.mile / totalMiles : 0);
      if (!point) continue;
      out.push({
        id: `traffic-${item.id}`,
        point,
        badge: "⚠",
        color: item.color ?? "#ea580c",
        title: item.category,
        lines: [item.text],
      });
    }
    for (const bridge of result.bridges?.items ?? []) {
      if (bridge.clearance === "ok") continue;
      const point = pointAlongRoute(geo, totalMiles > 0 ? bridge.mile / totalMiles : 0);
      if (!point) continue;
      out.push({
        id: `bridge-${bridge.id}`,
        point,
        badge: "🌉",
        color: bridge.clearance === "below" ? "#dc2626" : "#ea580c",
        title: "Bridge ahead",
        lines: [bridge.text],
      });
    }
    return out;
  }, [result]);
  const verdict = result ? (VERDICT[result.verdict.status] ?? { word: result.verdict.status, tone: "warn" }) : null;
  const why = result ? (result.verdict.tradeoffLines[0] ?? result.verdict.legalLines[0] ?? "") : "";
  const hours = result ? hoursLine(result) : null;

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
            <p className="sp-load">
              {run.status === "done" ? run.out.load?.label : ""}
              {run.status === "done" && run.savedAtMs !== undefined && (
                <span className="row-sub"> · planned {planAge(run.savedAtMs, nowTick)}</span>
              )}
            </p>
            <p className="sp-word">{verdict.word}</p>
            {why && <p className="sp-why">{why}</p>}
            {hours && <p className={hours.tight ? "sp-hours sp-hours-tight" : "sp-hours"}>{hours.text}</p>}
            {hours?.fromAppLog && (hours.tight || result.verdict.status === "late" || result.verdict.status === "not_legal") && (
              <p className="sp-hours-hint">
                Running on your carrier&apos;s ELD? If this app&apos;s log is behind, the plan is wrong.{" "}
                <button type="button" className="secondary" onClick={() => setShowChange(true)}>Use my ELD hours</button>
              </p>
            )}
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
          <fieldset className="sp-eld">
            <legend>My hours from my ELD (optional)</legend>
            <p className="row-sub">Copy what your carrier&apos;s ELD shows left, like 10:30. Used for 14 hours, counted down as time passes. Clear all three to go back to this app&apos;s log.</p>
            <label className="form-row">
              Drive left
              <input inputMode="decimal" placeholder="11:00" value={eldText.drive} onChange={(e) => setEldText({ ...eldText, drive: e.target.value })} />
            </label>
            <label className="form-row">
              Shift (14) left
              <input inputMode="decimal" placeholder="14:00" value={eldText.shift} onChange={(e) => setEldText({ ...eldText, shift: e.target.value })} />
            </label>
            <label className="form-row">
              Cycle (70/60) left
              <input inputMode="decimal" placeholder="45:00" value={eldText.cycle} onChange={(e) => setEldText({ ...eldText, cycle: e.target.value })} />
            </label>
            {eldError && <p role="alert">{eldError}</p>}
          </fieldset>
          <button type="submit">Plan it</button>
          <p className="row-sub">Food, sleep and workout are remembered on this phone.</p>
        </form>
      )}

      {/* 2. The map. */}
      <SmartPathMap
        geometry={result?.route.geometry ?? []}
        stops={mapStops}
        deadheadGeometry={result?.deadhead?.geometry ?? []}
        segments={mapSegments}
        hazards={mapHazards}
        caption={`Map © OpenStreetMap contributors.${result ? (result.route.truckLegal ? " Truck-checked route." : " Car route - NOT truck-checked.") : ""}${result?.traffic && result.traffic.segments.length > 0 ? " Red and orange stretches are reported delays." : ""}`}
      />

      {/* 3. Ahead on this route — the live call, in plain words. */}
      {result?.traffic && (result.traffic.call.decision !== "none" ||
        (result.bridges?.items.some((b) => b.clearance === "below" || b.clearance === "tight") ?? false)) && (
        <section aria-label="Ahead on this route">
          <h2>Ahead on this route</h2>
          {result.traffic.call.decision !== "none" && (
            <p style={{ fontSize: "1.25rem", fontWeight: 700 }}>{result.traffic.call.reason}</p>
          )}
          {result.bridges?.items
            .filter((b) => b.clearance === "below" || b.clearance === "tight")
            .map((b) => (
              <p key={b.id}>⚠ {b.text}</p>
            ))}
          <p className="row-sub">Live traffic and bridge clearances — see Details for the full list. A stretch with no color means no reported incident, not a clear road.</p>
        </section>
      )}

      {/* 4. Four key facts. */}
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

      {/* 5. The run, one line per stop. */}
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

      {/* 6. Everything else, folded. */}
      {result && (
        <details className="sp-details">
          <summary>
            Details — hours math, fuel ranking, weather, road work, state rules, traffic, bridges
            {result.warnings.length > 0 ? ` · ${result.warnings.length} notes` : ""}
          </summary>
          <p className="row-sub">{routeCaption(result.route)}</p>
          <SmartPathDetails result={result} />
        </details>
      )}
    </div>
  );
}
