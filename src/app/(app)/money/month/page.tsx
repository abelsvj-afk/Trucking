"use client";

// Money → This month (docs/design/monthly-income-goal.md, owner 2026-11-17): projected pay from booked and
// finished loads, his monthly goal, and the load that gets him there - "after this load I'll have enough,
// then I can worry about getting home". All arithmetic is in lib/monthly-income.ts; this only shows it.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { formatMoney } from "@/lib/money-format";
import { formatMoneyRange } from "@/lib/money-hub";
import { formatCalendarDay } from "@/lib/time";
import type { MonthIncomeView } from "@/services/api/monthly-income";

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; m: MonthIncomeView };

const shift = (month: string, by: number) => {
  const [y, mo] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthName = (month: string) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });

export default function MonthPage() {
  usePageTitle("This month");
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [state, setState] = useState<State>({ status: "loading" });
  const [goalText, setGoalText] = useState("");
  const [editing, setEditing] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiClient
      .monthIncome(month)
      .then((r) => {
        setState({ status: "ready", m: r.data });
        setGoalText(r.data.goalCents ? (r.data.goalCents / 100).toFixed(2) : "");
      })
      .catch((err: unknown) => setState({ status: "error", message: err instanceof ApiClientError ? err.message : "Couldn't load this month." }));
  }, [month]);
  useEffect(load, [load]);

  async function saveGoal(e: React.FormEvent) {
    e.preventDefault();
    const n = Number.parseFloat(goalText.replace(/[$,\s]/g, ""));
    const cents = goalText.trim() === "" ? null : Number.isFinite(n) && n > 0 ? Math.round(n * 100) : NaN;
    if (Number.isNaN(cents)) {
      setGoalError("Enter the amount you want to make this month, like 6,000.");
      return;
    }
    try {
      await apiClient.setMonthlyGoal(cents);
      setEditing(false);
      setGoalError(null);
      load();
    } catch (err) {
      setGoalError(err instanceof ApiClientError ? err.message : "Couldn't save the goal.");
    }
  }

  return (
    <div className="month-income">
      <PageHeader title="This month" purpose="What your booked and finished loads pay this month, your goal, and the load that gets you there." />
      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={load} />}
      {state.status === "ready" && (() => {
        const m = state.m;
        const pct = m.goalCents ? Math.min(100, Math.round((m.totalLowCents / m.goalCents) * 100)) : null;
        return (
          <>
            <nav className="month-nav" aria-label="Month">
              <button type="button" className="secondary" onClick={() => setMonth(shift(m.month, -1))}>‹</button>
              <strong>{monthName(m.month)}</strong>
              <button type="button" className="secondary" onClick={() => setMonth(shift(m.month, 1))}>›</button>
            </nav>
            {!m.hasTerms && (
              <p>No pay terms yet, so loads can&apos;t be priced. <Link href="/more/settings/pay">Add them in Settings → Pay terms</Link>.</p>
            )}
            <section aria-label="Projected pay" className="month-total">
              <p className="month-figure">{formatMoneyRange(m.totalLowCents, m.totalHighCents)}</p>
              <p className="row-sub">
                Earned {formatMoneyRange(m.earnedLowCents, m.earnedHighCents)} · booked ahead {formatMoneyRange(m.bookedLowCents, m.bookedHighCents)}
                {m.unpricedCount > 0 ? ` · ${m.unpricedCount} load${m.unpricedCount === 1 ? "" : "s"} I can't price yet (not counted)` : ""}
              </p>
            </section>

            <section aria-label="Goal" className="month-goal">
              {!m.goalReady && <p role="status">Saving a monthly goal isn&apos;t switched on yet (database update pending). The projection above still works.</p>}
              {m.goalReady && m.goalCents && !editing && (
                <>
                  <p>
                    Goal: <strong>{formatMoney(m.goalCents)}</strong>{" "}
                    <button type="button" className="button-danger-quiet" onClick={() => setEditing(true)}>Change</button>
                  </p>
                  <div className="month-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0}>
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <p role="status" className="month-verdict">
                    {m.goalLoad
                      ? `✅ After ${m.goalLoad.label} (delivery ${formatCalendarDay(m.goalLoad.deliveryDate)}) you're at your goal — time to plan the way home.`
                      : `${formatMoney(m.stillNeededCents ?? 0)} more to reach your goal with the loads booked so far.`}
                  </p>
                </>
              )}
              {m.goalReady && (!m.goalCents || editing) && (
                <form onSubmit={saveGoal} aria-label="Monthly goal">
                  <label className="form-row">
                    What do you want to make this month?
                    <input inputMode="decimal" value={goalText} onChange={(e) => setGoalText(e.target.value)} placeholder="6,000" />
                  </label>
                  <button type="submit">Save goal</button>
                  {editing && <button type="button" className="button-danger-quiet" onClick={() => setEditing(false)}>Cancel</button>}
                  {goalError && <p role="alert">{goalError}</p>}
                </form>
              )}
            </section>

            <section aria-label="Loads this month">
              <h2>Load by load</h2>
              {m.rows.length === 0 && <p>No booked or finished loads delivering this month yet.</p>}
              <ul className="month-loads">
                {m.rows.map((r) => (
                  <li key={r.loadId} className={r.reachesGoal ? "month-goal-row" : undefined}>
                    <Link href={`/loads/${r.loadId}`}>{r.label}</Link>
                    <span className="row-sub">
                      {" "}· delivery {formatCalendarDay(r.deliveryDate)} · {r.earned ? "earned" : "booked"} ·{" "}
                      {r.lowCents === null ? `can't price yet — ${r.note}` : formatMoneyRange(r.lowCents, r.highCents ?? r.lowCents)}
                    </span>
                    <span className="month-running">After this load: {formatMoneyRange(r.runningLowCents, r.runningHighCents)}{r.reachesGoal ? " ✅ goal reached" : ""}</span>
                  </li>
                ))}
              </ul>
            </section>

            {(m.advancesCents > 0 || m.deductionsCents > 0) && (
              <p className="row-sub">
                Also this month: advances {formatMoney(m.advancesCents)} and pay deductions {formatMoney(m.deductionsCents)}. The goal is measured
                against pay; advances are money you already have.
              </p>
            )}
          </>
        );
      })()}
    </div>
  );
}
