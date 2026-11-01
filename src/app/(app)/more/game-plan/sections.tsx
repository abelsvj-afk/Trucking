"use client";

// Game Plan tab sections (docs/design/gaming-system.md §4) -
// presentational pieces over the stored plan payload. All numbers
// come from the deterministic engine's frozen output on the plan
// row; nothing here computes a plan number of its own. Every
// projected figure is framed as a projection.

import { useState, type FormEvent } from "react";
import { formatDollars } from "@/lib/truck-fund";
import {
  EMERGENCY_CUSHION_FLOOR_CENTS,
  GAME_METRIC_LABELS,
  HOS_WEEKLY_ON_DUTY_CAP_HOURS,
  type ScenarioResult,
  type SideIncomeCandidate,
} from "@/lib/game-plan";
import type { GameCheckpoint, GamePlan, GameTarget } from "@/types/entities";

function dollars(cents: number): string {
  return formatDollars(cents);
}

function thinStamp(plan: GamePlan) {
  if (!plan.data_sufficiency.thinData) return null;
  return (
    <p>
      <strong>THIN DATA</strong> - built on {plan.data_sufficiency.completedLoads} settled loads /{" "}
      {plan.data_sufficiency.weeksOfHistory} weeks of records. A sketch, not a verdict.
    </p>
  );
}

// ------------------------------------------------------------------
// The trajectory lines (§3.1/§4.2): hand-rolled SVG polylines - no
// chart library in this repo. Values are the target metric's
// projected level per month, from each scenario's frozen points.
// ------------------------------------------------------------------

export function TrajectoryChart({ plan, target }: { plan: GamePlan; target: GameTarget }) {
  const out = plan.scenarios;
  const lines: { key: string; label: string; scenario: ScenarioResult; color: string; dash?: string }[] = [
    { key: "pace", label: "Current pace", scenario: out.scenarios.currentPace, color: "#8a8a8a" },
    { key: "cons", label: "Conservative", scenario: out.scenarios.conservative, color: "#2e7d32" },
    {
      key: "mixed",
      label: out.mixedDeclinedByPosture ? "Mixed (declined by your posture)" : "Mixed",
      scenario: out.scenarios.mixed,
      color: "#b26a00",
      dash: "5 4",
    },
    { key: "rec", label: "Recommended", scenario: out.scenarios.recommended, color: "#1565c0" },
  ];
  const maxMonths = Math.max(...lines.map((l) => l.scenario.points.length), 1);
  const maxValue = Math.max(
    out.gap.targetCents,
    ...lines.flatMap((l) => l.scenario.points.map((p) => p.metricCents)),
    1,
  );
  const W = 320;
  const H = 150;
  const PAD = 8;
  const x = (i: number) => PAD + (i / Math.max(maxMonths - 1, 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / maxValue) * (H - PAD * 2);
  const targetY = y(out.gap.targetCents);

  return (
    <section className="card">
      <h2>The paths (projection)</h2>
      {thinStamp(plan)}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Projected paths to the target" style={{ width: "100%", height: "auto" }}>
        <line x1={PAD} x2={W - PAD} y1={targetY} y2={targetY} stroke="#c62828" strokeWidth="1" strokeDasharray="2 3" />
        {lines.map((line) => (
          <polyline
            key={line.key}
            fill="none"
            stroke={line.color}
            strokeWidth="2"
            strokeDasharray={line.dash}
            points={line.scenario.points.map((p, i) => `${x(i)},${y(p.metricCents)}`).join(" ")}
          />
        ))}
      </svg>
      <ul>
        {lines.map((line) => (
          <li key={line.key}>
            <span style={{ color: line.color }}>●</span> {line.label}: {dollars(line.scenario.valueAtTargetCents)} by{" "}
            {out.gap.targetMonth}
            {line.scenario.shortfallCents === 0
              ? " - closes the gap"
              : ` - short ${dollars(line.scenario.shortfallCents)}`}
          </li>
        ))}
        <li>
          <span style={{ color: "#c62828" }}>●</span> Target: {dollars(out.gap.targetCents)} (
          {GAME_METRIC_LABELS[target.metric]})
        </li>
      </ul>
      <p>Projections from your records as of plan v{plan.version} - they move when your numbers move.</p>
    </section>
  );
}

// ------------------------------------------------------------------
// The gap block (§3.3/§3.5): said plainly, lever by lever. Lever
// contributions are the engine's per-lever delta at the TARGET
// month on the recommended path - not monthly amounts.
// ------------------------------------------------------------------

export function GapBlock({ plan }: { plan: GamePlan }) {
  const gap = plan.scenarios.gap;
  const rec = plan.scenarios.scenarios.recommended;
  return (
    <section className="card">
      <h2>The gap</h2>
      <p>
        Target {dollars(gap.targetCents)} by {gap.targetMonth}. Current pace lands at {dollars(gap.currentPaceCents)}{" "}
        (projection). The recommended path lands at {dollars(gap.recommendedCents)}
        {rec.shortfallCents === 0 ? " - the gap closes." : ` - short by ${dollars(rec.shortfallCents)}.`}
      </p>
      {plan.scenarios.levers.length > 0 && (
        <>
          <h3>What moves it, lever by lever</h3>
          <ul>
            {plan.scenarios.levers.map((line) => (
              <li key={line.key}>
                {line.label}: {line.contributionCents >= 0 ? "+" : ""}
                {dollars(line.contributionCents)} at the target month - {line.source}
              </li>
            ))}
          </ul>
        </>
      )}
      {gap.closers && (
        <p>
          Honest version: no path closes the gap by {gap.targetMonth}. At the recommended pace it closes about{" "}
          {gap.closers.extraMonthsAtRecommendedPace ?? "—"} month
          {gap.closers.extraMonthsAtRecommendedPace === 1 ? "" : "s"} later, or the target that IS reachable by the
          date is {dollars(gap.closers.reachableAtTargetDateCents)}. The only three honest moves: move the date, move
          the number, or add a lever - nothing here is hidden.
        </p>
      )}
      {plan.scenarios.removedForValidity.length > 0 && (
        <p>
          This plan replaced one that broke your Finance rules. Removed: {plan.scenarios.removedForValidity.join(" ")}
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------
// Milestone spine (§3.2): the sequenced journey, windows not dates.
// ------------------------------------------------------------------

export function MilestoneSpine({ plan }: { plan: GamePlan }) {
  const m = plan.scenarios.scenarios.recommended.milestones;
  return (
    <section className="card">
      <h2>The road</h2>
      <ol>
        <li>
          Emergency cushion: {dollars(plan.snapshot.emergencyFundBalanceCents)} of{" "}
          {dollars(EMERGENCY_CUSHION_FLOOR_CENTS)} (floor read from your Finance rules - the plan never spends below
          it).
        </li>
        <li>
          Truck window:{" "}
          {m.truckWindowMonth ? `around ${m.truckWindowMonth} (projection)` : "not inside this plan's horizon"}
        </li>
        <li>Authority filing: {m.authorityMonth ?? "not in horizon"}</li>
        {m.authorityReason && <li>{m.authorityReason}</li>}
        {m.sCorpFlag && (
          <li>
            Tax-structure flag: trailing net {dollars(m.sCorpTrailingNetCents)} is in the range where an S-corp
            election usually starts paying for itself (~$40k+). Worth a CPA conversation - the plan flags it, it
            doesn&apos;t file it.
          </li>
        )}
        <li>
          Hire #1 and the step-out end state: a named later increment - v1 games the truck and the authority,
          honestly, and says so.
        </li>
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------
// Demands block (§3.5): what the plan asks of HIM, vs his actuals.
// ------------------------------------------------------------------

export function DemandsBlock({ plan }: { plan: GamePlan }) {
  const d = plan.scenarios.scenarios.recommended.demands;
  const snap = plan.snapshot;
  return (
    <section className="card">
      <h2>What the plan demands</h2>
      <ul>
        <li>
          Hours: the plan runs at {d.totalHoursPerWeek} hrs/week total ({d.driveHoursPerWeek} driving,{" "}
          {d.onDutyHoursPerWeek} on duty, {d.sideHoursPerWeek} side) - the legal ceiling is{" "}
          {HOS_WEEKLY_ON_DUTY_CAP_HOURS} on-duty hrs/week (70-in-8-days pace). Your recent weeks average{" "}
          {snap.onDutyHoursPerWeek} on-duty hrs/week.
        </li>
        <li>
          Savings: the plan sweeps {d.requiredSweepPct}% of net into the Truck Fund. Your actual recent sweep rate
          is {d.actualSweepPct}% - the gap between those two numbers is the plan&apos;s real demand.
        </li>
        <li>
          Thinnest month: {d.thinnestCushionMonth ?? "n/a"} - cushion bottoms at {dollars(d.thinnestCushionCents)}
          {d.cushionBelowFloor
            ? " - BELOW the $10,000 floor (only a labelled what-if can look like this)."
            : " and never crosses below the $10,000 floor on a valid plan."}
        </li>
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------
// Assumption sheet (§2.5) + the what-if surface (§2.3).
// ------------------------------------------------------------------

const ASSUMPTION_LABELS: Record<string, string> = {
  net_per_week_cents: "Settled net per week",
  gross_revenue_per_week_cents: "Gross revenue per week",
  loads_per_week: "Loads per week",
  fuel_price_cents_gal: "Fuel price (per gallon)",
  sweep_pct: "Sweep into the Truck Fund",
  truck_price_cents: "Truck price",
  repair_reserve_cents: "Repair reserve held back",
  authority_startup_cents: "Authority startup cost",
  insurance_annual_cents: "Insurance (per year)",
  factoring_pct: "Factoring",
  truck_financing_cents: "Financed amount",
  authority_activation_month: "Authority activation month",
  side_income_levers: "Side-income levers",
  materiality_pct: "What counts as a material plan change",
};

function assumptionValueText(key: string, value: unknown): string {
  if (value == null) return "not set";
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return value
      .map((lever) => {
        const l = lever as { label?: string; monthlyLowCents?: number; monthlyHighCents?: number };
        return `${l.label ?? "lever"} (${dollars(l.monthlyLowCents ?? 0)}–${dollars(l.monthlyHighCents ?? 0)}/mo)`;
      })
      .join("; ");
  }
  if (typeof value === "number") {
    if (key.endsWith("_cents_gal")) return `$${(value / 100).toFixed(2)}`;
    if (key.endsWith("_cents")) return dollars(value);
    if (key.endsWith("_pct")) return `${value}%`;
    return String(value);
  }
  return String(value);
}

function assumptionSourceText(source: string): string {
  if (source === "his_data") return "from your records";
  if (source === "vision_estimate") return "planning estimate - ⚠️ VERIFY before you spend on it";
  if (source === "his_override") return "your override";
  if (source.startsWith("briefing:")) return "research briefing";
  return source;
}

export function AssumptionSheet({
  plan,
  candidates,
  whatIfs,
  busy,
  onWhatIf,
  onPromote,
}: {
  plan: GamePlan;
  candidates: SideIncomeCandidate[];
  whatIfs: GamePlan[];
  busy: boolean;
  onWhatIf: (overrides: Record<string, unknown>) => void;
  onPromote: (planId: string) => void;
}) {
  const [fuel, setFuel] = useState("");
  const [sweep, setSweep] = useState("");
  const [truckPrice, setTruckPrice] = useState("");
  const [financing, setFinancing] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    const overrides: Record<string, unknown> = {};
    if (fuel !== "") overrides.fuel_price_cents_gal = Math.round(Number(fuel) * 100);
    if (sweep !== "") overrides.sweep_pct = Number(sweep);
    if (truckPrice !== "") overrides.truck_price_cents = Math.round(Number(truckPrice) * 100);
    if (financing !== "") overrides.truck_financing_cents = Math.round(Number(financing) * 100);
    if (Object.keys(overrides).length > 0) onWhatIf(overrides);
  }

  return (
    <section className="card">
      <h2>What this plan stands on</h2>
      <p>Every assumption, with where it came from. A planning estimate is a placeholder - verify it before you spend on it.</p>
      <ul>
        {plan.assumptions.map((entry) => (
          <li key={entry.key}>
            {ASSUMPTION_LABELS[entry.key] ?? entry.key}: <strong>{assumptionValueText(entry.key, entry.value)}</strong>{" "}
            - {assumptionSourceText(entry.source)}
          </li>
        ))}
      </ul>
      {candidates.length > 0 && (
        <>
          <h3>Side income the plan may cite</h3>
          <p>Only these - a research briefing or something already on your record. Nothing generic is ever invented.</p>
          <ul>
            {candidates.map((c) => (
              <li key={`${c.sourceType}-${c.sourceId}`}>
                {c.sourceType === "briefing" ? "Briefing" : "On your record"}: {c.label}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Run a what-if</h3>
      <p>
        Change an assumption and re-game - it never touches your real data and never becomes the plan unless you say
        &quot;make that the plan&quot;.
      </p>
      <form onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="wi-fuel">Fuel ($/gal)</label>
          <input id="wi-fuel" type="number" step="0.01" min="0" value={fuel} onChange={(e) => setFuel(e.target.value)} />
        </div>
        <div className="form-row">
          <label htmlFor="wi-sweep">Sweep into the Truck Fund (%)</label>
          <input id="wi-sweep" type="number" step="1" min="0" max="100" value={sweep} onChange={(e) => setSweep(e.target.value)} />
        </div>
        <div className="form-row">
          <label htmlFor="wi-truck">Truck price ($)</label>
          <input id="wi-truck" type="number" step="1" min="1" value={truckPrice} onChange={(e) => setTruckPrice(e.target.value)} />
        </div>
        <div className="form-row">
          <label htmlFor="wi-fin">Financed amount ($) - a financed what-if names the Finance rule it breaks</label>
          <input id="wi-fin" type="number" step="1" min="0" value={financing} onChange={(e) => setFinancing(e.target.value)} />
        </div>
        <button type="submit" disabled={busy}>
          Game this what-if
        </button>
      </form>
      {whatIfs.length > 0 && (
        <>
          <h3>Your what-ifs</h3>
          <ul>
            {whatIfs.map((w) => (
              <li key={w.id}>
                <p>
                  <strong>v{w.version}</strong> - recommended path lands at {dollars(w.scenarios.gap.recommendedCents)} by{" "}
                  {w.scenarios.gap.targetMonth} (projection).
                </p>
                {w.scenarios.validity.violations.length > 0 && (
                  <p>
                    Breaks your Finance rules: {w.scenarios.validity.violations.map((v) => v.detail).join(" ")} Stored
                    as a labelled what-if only.
                  </p>
                )}
                {w.diff_summary && <p>{w.diff_summary}</p>}
                <button type="button" disabled={busy} onClick={() => onPromote(w.id)}>
                  Make that the plan
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------
// Version history (§2.2) + checkpoint scoreboard (§4.3).
// ------------------------------------------------------------------

export function VersionHistory({ versions }: { versions: GamePlan[] }) {
  if (versions.length === 0) return null;
  return (
    <section className="card">
      <h2>Plan history</h2>
      <p>Every game is kept - a new plan never silently replaces the old one.</p>
      <ul>
        {versions.map((v) => (
          <li key={v.id}>
            <strong>v{v.version}</strong> ({v.status.replace("_", " ")}) - trigger: {v.trigger.replace("_", " ")}
            {v.diff_summary ? ` - ${v.diff_summary}` : ""}
            {v.data_sufficiency.thinData ? " [thin data]" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CheckpointScoreboard({ checkpoints }: { checkpoints: GameCheckpoint[] }) {
  if (checkpoints.length === 0) return null;
  return (
    <section className="card">
      <h2>Monthly scoreboard</h2>
      <ul>
        {checkpoints.map((c) => (
          <li key={c.id}>
            {c.period_month.slice(0, 7)}:{" "}
            {c.verdict === "on_plan"
              ? "on plan"
              : c.verdict === "ahead"
                ? "ahead"
                : c.verdict === "behind"
                  ? `behind by ${dollars(Math.abs(c.gap_cents ?? 0))}`
                  : c.verdict === "no_data"
                    ? "no records that month"
                    : "open"}
            {c.lever_note ? ` - next lever: ${c.lever_note}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
