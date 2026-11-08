"use client";

// Home dashboard (docs/design/ui-ux.md, "UI/UX upgrade" section). The
// first screen answers three questions in order: what do I do next,
// where do my hours stand, and what does my driver pay look like -
// then offers the four quick actions and the assistant. The "This
// month" business financial summary at the bottom is the future
// company view and renders only when the owner switches it on in
// Settings (src/lib/home-display.ts). Task 3.11 built the money card;
// the UI/UX upgrade adds the next-step card, the duty clock (the
// Fleet → Hours of service summary, same lib/hos.ts math), and the
// quick actions around it.

import Link from "next/link";
import { useFinancialSummary } from "@/lib/use-financial-summary";
import { useApiList } from "@/lib/use-api-list";
import { useHosWindow } from "@/lib/use-hos-window";
import { ListLoading, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import DutyHud from "@/components/hud/DutyHud";
import NewsBanner from "@/components/NewsBanner";
import SetupChecklist from "@/components/SetupChecklist";
import AskAssistant from "@/components/AskAssistant";
import ActivePlanCard from "@/components/ActivePlanCard";
import ActiveLoadCard from "@/components/ActiveLoadCard";
import DriverPayHomeCard from "@/components/DriverPayHomeCard";
import DayWrapCard from "@/components/DayWrapCard";
import Reveal from "@/components/Reveal";
import NumberTicker from "@/components/NumberTicker";
import { Bot, ClipboardCheck, Fuel, PackagePlus } from "lucide-react";
import { summarizeHos } from "@/lib/hos";
import { usePageTitle } from "@/lib/use-page-title";
import { formatSinceTime } from "@/lib/time";
import { useNowTick } from "@/lib/use-now-tick";
import type { DutyLog } from "@/types/entities";
import { revenueConventionLabel } from "@/types/financial-summary";
import { useShowBusinessSummary } from "@/lib/home-display";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_LABELS: Record<DutyLog["duty_status"], string> = {
  off_duty: "Off duty",
  sleeper: "In the sleeper",
  driving: "Driving",
  on_duty: "On duty (not driving)",
};

// UH-12 fix (Home half): the paper/partial-day label for the Home
// HOS summary. The fields it reads (DutyLog.source /
// source_document_id, Document.photo_purpose / extracted_fields) are
// added by the img-maint paper-logs lane in the union, so they're
// read structurally here — on a tree without that lane every value
// is absent and the label is simply null. The RULES are the shared
// helper's (src/lib/hos-paper.ts on the img-maint tip): paper rows
// count from source === "paper_photo"; a day is partial when its
// paper sheet's paper_log_complete is false.
interface PaperDocLike {
  id: string;
  photo_purpose?: string | null;
  extracted_fields?: Record<string, unknown> | null;
}
function homeHosPaperLabel(logs: DutyLog[], documents: PaperDocLike[]): string | null {
  const paperDocs = new Map<string, { complete: boolean; date: string | null }>();
  for (const doc of documents) {
    if (doc.photo_purpose !== "paper_log") continue;
    const fields = doc.extracted_fields ?? {};
    paperDocs.set(doc.id, {
      complete: fields.paper_log_complete !== false,
      date: typeof fields.paper_log_date === "string" ? fields.paper_log_date : null,
    });
  }
  const rows = logs as (DutyLog & { source?: string | null; source_document_id?: string | null })[];
  const paperRowCount = rows.filter((r) => r.source === "paper_photo").length;
  if (paperRowCount === 0) return null;
  const partialDates = [
    ...new Set(
      rows
        .filter((r) => r.source_document_id && paperDocs.get(r.source_document_id)?.complete === false)
        .map((r) => paperDocs.get(r.source_document_id!)?.date ?? "that day"),
    ),
  ];
  const base = "Includes hours from your paper log sheet";
  return partialDates.length > 0
    ? `${base} — ${partialDates.length === 1 ? `the ${partialDates[0]} sheet was partial (unreadable spans aren't counted)` : "some sheets were partial (unreadable spans aren't counted)"}.`
    : `${base}.`;
}

export default function HomePage() {
  usePageTitle("Home");
  const { state, retry } = useFinancialSummary();
  // The "This month" business summary below is the future company
  // view; hidden unless the owner switches it on in Settings
  // (src/lib/home-display.ts, owner order 2026-11-07).
  const showBusinessSummary = useShowBusinessSummary();
  // The full carrier-anchored window (never a newest-200 page that could
  // truncate the history the cycle depends on) - the same read as the HUD
  // and the Hours page; live via the live layer.
  const hosWindow = useHosWindow();
  // UH-12 fix: documents feed the paper/partial label under the hours.
  const documents = useApiList<PaperDocLike & Record<string, unknown>>("documents", { limit: "200" });

  const nowMs = useNowTick(60_000);
  const logs = hosWindow.state.status === "loaded" ? hosWindow.state.data : [];
  const paperLabel =
    documents.state.status === "loaded" ? homeHosPaperLabel(logs, documents.state.result.data) : null;
  const summaryRaw = hosWindow.state.status === "loaded" ? summarizeHos(logs) : null;
  // hos.ts's rolling 8-day warning is superseded by the carrier-anchored
  // cycle (its own warning comes from the window endpoint); showing both
  // would state two different weekly totals.
  const summary =
    summaryRaw && hosWindow.state.status === "loaded"
      ? {
          ...summaryRaw,
          warnings: [
            ...summaryRaw.warnings.filter((w) => !w.includes("8-day on-duty limit")),
            ...hosWindow.state.hos.warnings,
          ],
        }
      : null;
  const latest = [...logs].sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
  const onTheClock = latest != null && (latest.duty_status === "driving" || latest.duty_status === "on_duty");

  return (
    <div>
      <PageHeader
        title="Road to Legacy"
        purpose="Your whole business at a glance — hours, money, and the one thing to do next."
      />

      <DutyHud />

      {/* Pay preview stays visible right under the hours (map-first Home). */}
      <DriverPayHomeCard />

      <NewsBanner />

      <SetupChecklist />

      <Reveal aria-label="Your next step" className="next-step" index={0}>
        <h2>Your next step</h2>
        {hosWindow.state.status === "loading" && <p>Checking your hours…</p>}
        {hosWindow.state.status === "error" && (
          <p>
            Couldn&apos;t load your hours just now. <Link href="/fleet/hos">Open Hours of service</Link> to
            see where you stand.
          </p>
        )}
        {hosWindow.state.status === "loaded" && logs.length === 0 && (
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
        {hosWindow.state.status === "loaded" && logs.length > 0 && summary != null && latest != null && (
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
                {formatSinceTime(latest.started_at, nowMs)}.
                Ready to roll? Log your next duty status when you start.
              </p>
            )}
            <Link href="/fleet/hos" className="page-action">
              See my hours
            </Link>
          </>
        )}
      </Reveal>

      <ActiveLoadCard />

      <ActivePlanCard />

      <DayWrapCard />

      <Reveal aria-label="Quick actions" index={1}>
        <h2>Quick actions</h2>
        <div className="quick-actions">
          <Link href="/fleet/pretrip-inspections/new">
            <ClipboardCheck size={20} strokeWidth={1.75} aria-hidden="true" /> Start pre-trip
          </Link>
          <Link href="/money/fuel-purchases/new">
            <Fuel size={20} strokeWidth={1.75} aria-hidden="true" /> Log fuel
          </Link>
          <Link href="/loads/new">
            <PackagePlus size={20} strokeWidth={1.75} aria-hidden="true" /> Add load
          </Link>
          <Link href="/more/assistant">
            <Bot size={20} strokeWidth={1.75} aria-hidden="true" /> Ask Abel
          </Link>
        </div>
      </Reveal>

      {logs.length > 0 && (
        <p className="row-sub">
          {paperLabel && <>{paperLabel} </>}
          <Link href="/fleet/hos">Hours of service</Link>
        </p>
      )}

      {showBusinessSummary && (
      <Reveal aria-label="This month's financial summary" index={3}>
        <h2>This month</h2>
        {state.status === "loading" && <ListLoading />}
        {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
        {state.status === "loaded" && (
          <dl>
            {/* Unit C labeling rule (C.3): the revenue figure is
                operational load revenue recognized on delivery -
                never worded as cash received or settled. The label
                renders from the API's revenueConvention field. */}
            <dt>{revenueConventionLabel(state.summary.revenueConvention)}</dt>
            <dd>
              <NumberTicker value={state.summary.revenue_cents} format={(v) => formatDollars(Math.round(v))} />
            </dd>
            <dt>Expenses</dt>
            <dd>
              <NumberTicker
                value={state.summary.expenses_cents + state.summary.fuel_cents + state.summary.maintenance_cents}
                format={(v) => formatDollars(Math.round(v))}
              />
            </dd>
            <dt>Operating result</dt>
            <dd>
              <NumberTicker value={state.summary.net_cents} format={(v) => formatDollars(Math.round(v))} />
            </dd>
          </dl>
        )}
        {state.status === "loaded" && state.summary.estimatedPay && state.summary.estimatedPay.loadCount > 0 && (
          <p className="row-sub" role="note">
            {state.summary.estimatedPay.loadCount} delivered load{state.summary.estimatedPay.loadCount === 1 ? " has" : "s have"} no rate recorded, so revenue shows $0 — at your pay terms times the miles that is about{" "}
            {formatDollars(state.summary.estimatedPay.cents)} (an estimate, not added above).
          </p>
        )}
        <Link href="/money/summary">View full summary</Link>
      </Reveal>
      )}

      <AskAssistant
        heading="Abel knows your loads, hours, money, and fleet — and can log things for you. Try one:"
        prompts={[
          "How many hours do I have left today?",
          "What did I earn this week?",
          "Log a fuel stop: $120 at Pilot",
        ]}
      />
    </div>
  );
}
