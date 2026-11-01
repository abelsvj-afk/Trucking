"use client";

// Gaming System (docs/design/gaming-system.md) - the Game Plan tab.
// His target, gamed against his real numbers: three projection
// lines (current pace / conservative / mixed), the gap at the
// target date and what closes it, the truck + authority windows,
// what the plan demands of him, and the assumption sheet every
// number stands on. Everything here is a PROJECTION, labelled as
// such at every surface - never a promise.
//
// The five owner decisions ship with the design's defaults, and
// the defaults are visible in the copy below so he can overrule
// any of them: metric defaults to monthly net; the mixed path
// renders even at conservative posture, labelled declined-by-
// posture; checkpoints close monthly; a what-if never becomes
// the plan without his explicit "make that the plan"; the
// $10,000 emergency-cushion floor is READ from his Finance rules
// (lib/truck-fund), never set here.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { formatDollars } from "@/lib/truck-fund";
import { GAME_METRIC_LABELS, type GameMetric } from "@/lib/game-plan";
import type { GamePlanPageData } from "@/types/game-plan";
import type { GameTarget } from "@/types/entities";
import {
  AssumptionSheet,
  CheckpointScoreboard,
  DemandsBlock,
  GapBlock,
  MilestoneSpine,
  TrajectoryChart,
  VersionHistory,
} from "./sections";

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: GamePlanPageData };

const METRIC_OPTIONS: { value: GameMetric; label: string }[] = [
  { value: "monthly_net_cents", label: `${GAME_METRIC_LABELS.monthly_net_cents} (default - the number your records feed today)` },
  { value: "truck_fund_cents", label: GAME_METRIC_LABELS.truck_fund_cents },
  { value: "business_value_cents", label: `${GAME_METRIC_LABELS.business_value_cents} (rough by design - labelled crude)` },
  { value: "net_worth_cents", label: `${GAME_METRIC_LABELS.net_worth_cents} (partial: business-only until accounts connect)` },
];

export default function GamePlanPage() {
  usePageTitle("Game Plan");
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    apiClient
      .gamePlan()
      .then((data) => setState({ status: "loaded", data }))
      .catch((err) =>
        setState({
          status: "error",
          message: err instanceof ApiClientError ? err.message : "Could not load your Game Plan.",
        }),
      );
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const data = state.status === "loaded" ? state.data : null;

  async function runAction(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "That didn't go through - try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Game Plan"
        purpose="Your target, gamed from your real numbers - what closes the gap, when the truck and the authority land, and what it demands of you. Every number is a projection, not a promise."
      />
      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={reload} />}
      {actionError && <p className="form-error">{actionError}</p>}
      {data && (
        <>
          {!data.capability_enabled && (
            <section className="card">
              <h2>The planner is off</h2>
              <p>
                The Game Plan capability is OFF, so no plan is being gamed. Your target still saves here.
                Turn it on in <Link href="/more/settings">Account &amp; settings</Link> (&quot;Game Plan&quot;)
                and the next save - or the Re-game button - builds the plan.
              </p>
            </section>
          )}
          <TargetSection
            data={data}
            busy={busy}
            onSave={(body, existing) =>
              runAction(() =>
                existing ? apiClient.updateGameTarget(existing.id, body) : apiClient.createGameTarget(body),
              )
            }
          />
          {data.target && data.current_plan && (
            <>
              <TrajectoryChart plan={data.current_plan} target={data.target} />
              <GapBlock plan={data.current_plan} />
              <MilestoneSpine plan={data.current_plan} />
              <DemandsBlock plan={data.current_plan} />
              <section className="card">
                <h2>The plan, in plain words</h2>
                <p style={{ whiteSpace: "pre-wrap" }}>{data.current_plan.narration}</p>
                {data.current_plan.data_sufficiency.thinData && (
                  <p>
                    <strong>Thin data:</strong> this plan is built on {data.current_plan.data_sufficiency.completedLoads}{" "}
                    settled loads and {data.current_plan.data_sufficiency.weeksOfHistory} weeks of records. Treat it as
                    a sketch - it sharpens as your history does.
                  </p>
                )}
              </section>
              <AssumptionSheet
                plan={data.current_plan}
                candidates={data.side_income_candidates}
                busy={busy}
                onWhatIf={(overrides) => runAction(() => apiClient.gameWhatIf(overrides))}
                onPromote={(planId) => runAction(() => apiClient.promoteGamePlan(planId))}
                whatIfs={data.versions.filter((v) => v.status === "what_if")}
              />
            </>
          )}
          {data.target && !data.current_plan && (
            <section className="card">
              <h2>No plan gamed yet</h2>
              <p>
                Re-games today: {data.usage.re_games_today} of {data.usage.max_re_games_per_day}.{" "}
                <button type="button" disabled={busy} onClick={() => runAction(() => apiClient.regameGamePlan())}>
                  Re-game my plan
                </button>
              </p>
            </section>
          )}
          <VersionHistory versions={data.versions} />
          <CheckpointScoreboard checkpoints={data.checkpoints} />
          <section className="card">
            <h2>How this works</h2>
            <p>
              The engine is math, not vibes: your settled income, your real costs, your fund, your hours. Side income
              only ever comes from a research briefing or a skill already on your record - never generic hustle
              advice. A plan that would break your Finance rules (borrowing before the $10,000 cushion, insurance
              lapsing, illegal hours) is refused and replaced with the nearest plan that plays by them, with what
              was removed said out loud. Checkpoints close monthly (default) with one Telegram message - verdict,
              cause, one lever. What-ifs never become the plan on their own.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function TargetSection({
  data,
  busy,
  onSave,
}: {
  data: GamePlanPageData;
  busy: boolean;
  onSave: (body: Record<string, unknown>, existing: GameTarget | null) => void;
}) {
  const target = data.target;
  const [editing, setEditing] = useState(false);
  const [metric, setMetric] = useState<GameMetric>(target?.metric ?? "monthly_net_cents");
  const [valueDollars, setValueDollars] = useState(
    target ? String(target.target_value_cents / 100) : "",
  );
  const [date, setDate] = useState(target?.target_date ?? "");
  const [posture, setPosture] = useState<"conservative" | "mixed">(target?.posture ?? "conservative");
  const [mixPct, setMixPct] = useState(target?.posture_mix_pct ?? 0);
  const [notes, setNotes] = useState(target?.notes ?? "");
  const [seededFor, setSeededFor] = useState<string | null>(target?.id ?? null);

  // Re-seed the form when a different target lands (e.g. after save).
  if (target && seededFor !== target.id) {
    setSeededFor(target.id);
    setMetric(target.metric);
    setValueDollars(String(target.target_value_cents / 100));
    setDate(target.target_date ?? "");
    setPosture(target.posture);
    setMixPct(target.posture_mix_pct);
    setNotes(target.notes ?? "");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const dollars = Number(valueDollars);
    if (!Number.isFinite(dollars) || dollars <= 0) return;
    onSave(
      {
        metric,
        target_value_cents: Math.round(dollars * 100),
        target_date: date === "" ? null : date,
        posture,
        posture_mix_pct: posture === "mixed" ? mixPct : 0,
        notes: notes.trim() === "" ? undefined : notes.trim(),
      },
      target,
    );
    setEditing(false);
  }

  if (target && !editing) {
    return (
      <section className="card">
        <h2>Your target</h2>
        <p>
          <strong>
            {GAME_METRIC_LABELS[target.metric]}: {formatDollars(target.target_value_cents)}
          </strong>
          {target.target_date ? ` by ${target.target_date}` : " (open-ended - gamed over 36 months)"}
        </p>
        {target.metric === "net_worth_cents" && (
          <p>Partial: business-only until accounts connect (Plaid is a later step - the app never guesses at accounts it cannot see).</p>
        )}
        <p>
          Posture: {target.posture === "conservative" ? "Conservative - trucking carries the plan" : `Mixed - side income may carry up to ${target.posture_mix_pct}% of the gap`}
          {target.posture === "conservative" &&
            ". The mixed path still renders below, labelled declined-by-posture, so you can see what you're saying no to."}
        </p>
        {target.notes && <p>&quot;{target.notes}&quot;</p>}
        <p>
          Re-games today: {data.usage.re_games_today} of {data.usage.max_re_games_per_day} (any edit re-games
          automatically).{" "}
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>
            Edit target
          </button>
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>{target ? "Edit your target" : "Set your target"}</h2>
      {!target && (
        <p>
          One target at a time - the outcome everything else is sequenced against. &quot;Be rich by [date]&quot;
          becomes a number, a date, and a posture: how much of the gap trucking alone must carry.
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="gp-metric">What are we aiming at?</label>
          <select id="gp-metric" value={metric} onChange={(e) => setMetric(e.target.value as GameMetric)}>
            {METRIC_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="gp-value">Target ($)</label>
          <input
            id="gp-value"
            type="number"
            min="1"
            step="any"
            required
            value={valueDollars}
            onChange={(e) => setValueDollars(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label htmlFor="gp-date">By when? (blank = open-ended)</label>
          <input id="gp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="form-row">
          <label htmlFor="gp-posture">Posture</label>
          <select
            id="gp-posture"
            value={posture}
            onChange={(e) => {
              const next = e.target.value as "conservative" | "mixed";
              setPosture(next);
              setMixPct(next === "mixed" ? Math.max(mixPct, 50) : 0);
            }}
          >
            <option value="conservative">Conservative - trucking only</option>
            <option value="mixed">Mixed - trucking + side income</option>
          </select>
        </div>
        {posture === "mixed" && (
          <div className="form-row">
            <label htmlFor="gp-mix">
              How much of the gap may side income carry? {mixPct}% (slider - owner decision, default 50)
            </label>
            <input
              id="gp-mix"
              type="range"
              min="0"
              max="100"
              step="5"
              value={mixPct}
              onChange={(e) => setMixPct(Number(e.target.value))}
            />
          </div>
        )}
        <div className="form-row">
          <label htmlFor="gp-notes">What this target means, in your words (optional)</label>
          <input id="gp-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <button type="submit" disabled={busy}>
          {target ? "Save target & re-game" : "Set target & game the plan"}
        </button>
        {target && (
          <button type="button" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </form>
    </section>
  );
}
