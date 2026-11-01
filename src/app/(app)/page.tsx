"use client";

// Home dashboard (docs/design/ui-ux.md, "UI/UX upgrade" section). The
// first screen answers three questions in order: what do I do next,
// where do my hours stand, and how's the money this month - then
// offers the four quick actions and the assistant. Task 3.11 built the
// money card; the UI/UX upgrade adds the next-step card, the duty
// clock (the Fleet → Hours of service summary, same lib/hos.ts math),
// and the quick actions around it.

import Link from "next/link";
import { useFinancialSummary } from "@/lib/use-financial-summary";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import AskAssistant from "@/components/AskAssistant";
import { summarizeHos } from "@/lib/hos";
import { usePageTitle } from "@/lib/use-page-title";
import type { DutyLog } from "@/types/entities";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const STATUS_LABELS: Record<DutyLog["duty_status"], string> = {
  off_duty: "Off duty",
  sleeper: "In the sleeper",
  driving: "Driving",
  on_duty: "On duty (not driving)",
};

export default function HomePage() {
  usePageTitle("Home");
  const { state, retry } = useFinancialSummary();
  const duty = useApiList<DutyLog>("duty-logs", { limit: "200" });

  const logs = duty.state.status === "loaded" ? duty.state.result.data : [];
  const summary = duty.state.status === "loaded" ? summarizeHos(logs) : null;
  const latest = [...logs].sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
  const onTheClock = latest != null && (latest.duty_status === "driving" || latest.duty_status === "on_duty");

  return (
    <div>
      <PageHeader
        title="Trucking OS"
        purpose="Your whole business at a glance — hours, money, and the one thing to do next."
      />

      <section aria-label="Your next step" className="next-step">
        <h2>Your next step</h2>
        {duty.state.status === "loading" && <p>Checking your hours…</p>}
        {duty.state.status === "error" && (
          <p>
            Couldn&apos;t load your hours just now. <Link href="/fleet/hos">Open Hours of service</Link> to
            see where you stand.
          </p>
        )}
        {duty.state.status === "loaded" && logs.length === 0 && (
          <>
            <p>
              Start your day on the books: log your first duty status so your hours are tracked from the
              first mile.
            </p>
            <Link href="/fleet/hos/new" className="page-action">
              Log duty status
            </Link>
          </>
        )}
        {duty.state.status === "loaded" && logs.length > 0 && summary != null && latest != null && (
          <>
            {summary.warnings.length > 0 ? (
              <p role="alert">{summary.warnings[0]}</p>
            ) : onTheClock ? (
              <p>
                You&apos;re on the clock ({STATUS_LABELS[latest.duty_status].toLowerCase()}). When you stop,
                log the change so your hours stay honest.
              </p>
            ) : (
              <p>
                You&apos;re {STATUS_LABELS[latest.duty_status].toLowerCase()} since{" "}
                {new Date(latest.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
                Ready to roll? Log your next duty status when you start.
              </p>
            )}
            <Link href="/fleet/hos" className="page-action">
              See my hours
            </Link>
          </>
        )}
      </section>

      <section aria-label="Quick actions">
        <h2>Quick actions</h2>
        <div className="quick-actions">
          <Link href="/fleet/pretrip-inspections/new">Start pre-trip</Link>
          <Link href="/money/fuel-purchases/new">Log fuel</Link>
          <Link href="/loads/new">Add load</Link>
          <Link href="/more/assistant">Ask the assistant</Link>
        </div>
      </section>

      {summary && logs.length > 0 && (
        <section aria-label="Your hours today">
          <h2>Your hours</h2>
          <dl>
            <dt>Driving left (11h)</dt>
            <dd>{formatMinutes(Math.max(0, 11 * 60 - summary.drivingMinutesInWindow))}</dd>
            <dt>Window left (14h)</dt>
            <dd>{formatMinutes(Math.max(0, 14 * 60 - summary.windowElapsedMinutes))}</dd>
            <dt>Before a 30-min break</dt>
            <dd>{formatMinutes(Math.max(0, 8 * 60 - summary.drivingMinutesSinceBreak))}</dd>
            <dt>Left in 8 days (70h)</dt>
            <dd>{formatMinutes(Math.max(0, 70 * 60 - summary.onDutyMinutesLast8Days))}</dd>
          </dl>
          <p className="row-sub">
            Paper-log helper, not an ELD — from what you&apos;ve logged here. The truck&apos;s ELD is the
            legal record.
          </p>
          <Link href="/fleet/hos">Hours of service</Link>
        </section>
      )}

      <section aria-label="This month's financial summary">
        <h2>This month</h2>
        {state.status === "loading" && <ListLoading />}
        {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
        {state.status === "loaded" && (
          <dl>
            <dt>Revenue</dt>
            <dd>{formatDollars(state.summary.revenue_cents)}</dd>
            <dt>Expenses</dt>
            <dd>
              {formatDollars(
                state.summary.expenses_cents +
                  state.summary.fuel_cents +
                  state.summary.maintenance_cents,
              )}
            </dd>
            <dt>Net</dt>
            <dd>{formatDollars(state.summary.net_cents)}</dd>
          </dl>
        )}
        <Link href="/money/summary">View full summary</Link>
      </section>

      <AskAssistant
        heading="King knows your loads, hours, money, and fleet — and can log things for you. Try one:"
        prompts={[
          "How many hours do I have left today?",
          "What did I earn this week?",
          "Log a fuel stop: $120 at Pilot",
        ]}
      />
    </div>
  );
}
