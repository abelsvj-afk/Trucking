"use client";

// Money → Driver pay (renamed from "Projected pay", Phase 4 spec §2.4 —
// the route /money/pay is unchanged): this pay week's running total, last week's (and its payday), and the
// per-load breakdown behind Home's preview - mile part, percent part, or the figure he set on the load.
// Every row says which miles it counted; while the miles basis is unset the
// totals are a range, labeled. Gross at his stated rate - not net, not cash,
// not a settlement.

import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import { usePayProjection } from "@/lib/use-pay-projection";
import PayTermsCard from "@/components/PayTermsCard";
import { formatDay, formatRange, type PeriodProjection } from "@/lib/pay-projection";
import { advancesForPeriod, netRange, sumAdvances, type AdvanceLike } from "@/lib/cash-advances";
import { deductionsForPeriod, sumDeductions, type DeductionLike } from "@/lib/expense-buckets";
import { formatMoney } from "@/lib/money-format";

function PeriodBlock({
  title,
  period,
  empty,
  advances,
  advancesAvailable,
  deductions,
  deductionsAvailable,
}: {
  title: string;
  period: PeriodProjection;
  empty: string;
  advances: AdvanceLike[];
  advancesAvailable: boolean;
  deductions: (DeductionLike & { category?: string | null })[];
  deductionsAvailable: boolean;
}) {
  const periodAdvances = advancesForPeriod(advances, period.start, period.end);
  const advancesCents = sumAdvances(periodAdvances);
  const periodDeductions = deductionsForPeriod(deductions, period.start, period.end);
  const deductionsCents = sumDeductions(periodDeductions);
  const outAvailable = advancesAvailable && deductionsAvailable;
  const net = netRange(period.lowCents, period.highCents, advancesCents + deductionsCents);
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      <p role="status">
        <strong>{formatRange(period.lowCents, period.highCents)}</strong> · {formatDay(period.start)} to {formatDay(period.end)}
        {period.statement ? ` · statement ${formatDay(period.statement)}` : ""}
        {period.payday ? ` · paid ${formatDay(period.payday)}` : ""}
      </p>
      {outAvailable && advancesCents > 0 && (
        <p role="status">
          − {formatMoney(advancesCents)} in <Link href="/money/advances">cash advances</Link> already taken out of this pay
        </p>
      )}
      {outAvailable && deductionsCents > 0 && (
        <p role="status">
          − {formatMoney(deductionsCents)} in <Link href="/money/expenses">pay deductions</Link> coming out of this pay
        </p>
      )}
      {outAvailable && (advancesCents > 0 || deductionsCents > 0) && (
        <p role="status">
          <strong>net you should get: {formatRange(net.lowCents, net.highCents)}</strong>
          {net.highCents < 0 ? " — more taken out than this period is expected to pay" : ""}
        </p>
      )}
      {period.rows.length === 0 && <p>{empty}</p>}
      {period.rows.length > 0 && (
        <ul>
          {period.rows.map(({ load, projection }) => (
            <li key={load.id}>
              <span className="row-title">
                <Link href={`/loads/${load.id}`}>{load.origin} → {load.destination}</Link>
              </span>
              <span className="row-sub">
                {formatDay((load.delivery_date ?? load.pickup_date) as string)} ·{" "}
                {projection.lowCents === null || projection.highCents === null
                  ? "can't project yet"
                  : formatRange(projection.lowCents, projection.highCents)}
                {projection.overridden ? " · your figure" : ""}
              </span>
              <span className="row-sub">{projection.counted ? `Counted: ${projection.counted}. ` : ""}{projection.note}</span>
              <span className="row-sub"><Link href={`/loads/${load.id}`}>Edit this load&apos;s pay</Link></span>
            </li>
          ))}
        </ul>
      )}
      {period.excludedCount > 0 && (
        <p className="row-sub">{period.excludedCount} draft or cancelled load{period.excludedCount === 1 ? "" : "s"} left out.</p>
      )}
    </section>
  );
}

export default function ProjectedPayPage() {
  usePageTitle("Driver pay");
  const state = usePayProjection();

  return (
    <div>
      <PageHeader
        title="Driver pay"
        purpose="What your loads are worth at your pay terms, week by week toward payday - updating as loads and details come in."
      />
      {/* Phase 4 (spec §2.4): the pay-terms card sits at the top, next
          to the numbers it drives — rendered from the live terms,
          edited in place via a Sheet. Settings keeps its own copy. */}
      {state.status === "ready" && <PayTermsCard terms={state.terms} />}
      {state.status === "no-terms" && <PayTermsCard terms={null} />}
      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message="Couldn't load your loads or pay terms." onRetry={() => window.location.reload()} />}
      {state.status === "no-terms" && (
        <p>
          You haven&apos;t entered pay terms yet. Add them with the card above (per mile, a percent of the
          load, or both) and this fills in.
        </p>
      )}
      {state.status === "ready" && (
        <>
          {state.period.basisAssumed && (
            <p role="note">
              Your miles basis isn&apos;t set, so loads paid by the mile show a range — loaded miles only at the low end, all miles (with
              deadhead) at the high end. <Link href="/more/settings/pay">Set which miles are paid</Link> to get one number.
            </p>
          )}
          {state.period.unavailableCount > 0 && (
            <p role="note">{state.period.unavailableCount} load{state.period.unavailableCount === 1 ? "" : "s"} this week can&apos;t be projected yet — each row says what is missing.</p>
          )}
          {!state.period.weekEndSet && (
            <p className="row-sub" role="note">
              Your pay week isn&apos;t set, so weeks run Monday to Sunday. <Link href="/more/settings/pay">Set the day it ends and your payday</Link>.
            </p>
          )}
          {(!state.advancesAvailable || !state.deductionsAvailable) && (
            <p role="note">
              {!state.advancesAvailable && !state.deductionsAvailable
                ? "Cash advances and pay deductions couldn't load, so the figures below don't take either out — no net is shown until they load."
                : !state.advancesAvailable
                  ? "Cash advances couldn't load, so the figures below don't take advances out — no net is shown until they load."
                  : "Pay deductions couldn't load, so the figures below don't take deductions out — no net is shown until they load."}
            </p>
          )}
          <PeriodBlock title="This pay week so far" period={state.period} empty="No booked loads this pay week yet." advances={state.advances} advancesAvailable={state.advancesAvailable} deductions={state.deductions} deductionsAvailable={state.deductionsAvailable} />
          <PeriodBlock title="Last pay week" period={state.previous} empty="No booked loads last pay week." advances={state.advances} advancesAvailable={state.advancesAvailable} deductions={state.deductions} deductionsAvailable={state.deductionsAvailable} />
          <p className="row-sub">
            Gross pay at your stated terms, before fuel and taxes;{" "}
            {state.advancesAvailable && state.deductionsAvailable
              ? "cash advances and pay deductions you recorded are taken out above so the net is what should land."
              : "part of what comes out of your pay couldn't be loaded, so no net is shown above."}{" "}
            It is a projection — your settlement is the final number.
          </p>
        </>
      )}
    </div>
  );
}
