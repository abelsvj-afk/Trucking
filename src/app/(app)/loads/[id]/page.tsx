"use client";

// UI/UX upgrade: the load's own screen. A load's expenses, documents,
// and duty logs were three separate lists in three corners of the app
// with nothing tying them together - this screen is the tie: the
// load's facts up top, everything recorded against it below (the
// expenses/duty-logs list endpoints now whitelist ?load_id=, so each
// section is one exact-match query), and the route check one tap
// away. Fuel is deliberately NOT here: fuel_purchases has no load_id
// in the data model (fuel is recorded per truck), so a per-load fuel
// figure would be invented, not computed.

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { useApiList } from "@/lib/use-api-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { DetentionStamp, DutyLog, Expense, Load } from "@/types/entities";
import type { DetentionSummary } from "@/lib/detention";
import type { PaperworkState } from "@/lib/paperwork";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatStampTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STAMP_BUTTONS: { type: string; label: string }[] = [
  { type: "arrival", label: "Stamp arrival" },
  { type: "door", label: "Stamp door" },
  { type: "loading_done", label: "Stamp done" },
  { type: "departure", label: "Stamp departure" },
];

// GAP-04: the facility clock, on the load where the argument
// happens. One tap stamps now; times stay correctable through the
// API. The owed figure quotes lib/detention.ts — the same numbers
// the claim pack and Abel quote.
function DetentionSection({ load }: { load: Load }) {
  const [stamps, setStamps] = useState<DetentionStamp[]>([]);
  const [summary, setSummary] = useState<DetentionSummary | null>(null);
  const [stopKind, setStopKind] = useState<"pickup" | "delivery">("delivery");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .detention(load.id)
      .then((result) => {
        if (!cancelled) {
          setStamps(result.data);
          setSummary(result.summary);
        }
      })
      .catch(() => {
        if (!cancelled) setNote("Couldn't load the detention clock.");
      });
    return () => {
      cancelled = true;
    };
  }, [load.id]);

  async function stamp(type: string) {
    setBusy(true);
    setNote(null);
    try {
      await apiClient.stampDetention(load.id, { stamp_type: type, stop_kind: stopKind });
      const result = await apiClient.detention(load.id);
      setStamps(result.data);
      setSummary(result.summary);
    } catch {
      setNote("Couldn't save that stamp. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Detention clock">
      <h2>Detention clock</h2>
      {stamps.length === 0 && (
        <p className="row-sub">
          No stamps yet. Written-down times are how detention gets paid — stamp arrival when you
          check in.
        </p>
      )}
      <ul>
        {stamps.map((s) => (
          <li key={s.id}>
            {s.stop_kind === "pickup" ? "Pickup" : "Delivery"} ·{" "}
            {s.stamp_type.replace("_", " ")} — {formatStampTime(s.occurred_at)}
          </li>
        ))}
      </ul>
      {summary && summary.stops.length > 0 && (
        <p>
          {summary.anyClockOpen
            ? "Clock running. "
            : summary.totalOwedCents != null
              ? `Detention owed: ${formatDollars(summary.totalOwedCents)} (${summary.totalBillableHours} billable hr past ${summary.freeMinutes} free min${summary.freeMinutesAssumed ? ", assumed — no free time on the rate con" : ""}).`
              : `${summary.totalBillableHours} billable hour(s) past free time — add the detention rate from the rate con to price it.`}
        </p>
      )}
      <div role="group" aria-label="Stamp the clock">
        <label>
          Stop{" "}
          <select
            value={stopKind}
            onChange={(event) => setStopKind(event.target.value as "pickup" | "delivery")}
          >
            <option value="delivery">Delivery</option>
            <option value="pickup">Pickup</option>
          </select>
        </label>{" "}
        {STAMP_BUTTONS.map((button) => (
          <button key={button.type} type="button" disabled={busy} onClick={() => stamp(button.type)}>
            {button.label}
          </button>
        ))}
      </div>
      {note && <p role="alert">{note}</p>}
    </section>
  );
}

// GAP-05: paperwork state + the completion warning. Completing a
// load with gaps warns once, plainly, before it saves.
function PaperworkSection({ load, onCompleted }: { load: Load; onCompleted: () => void }) {
  const [state, setState] = useState<PaperworkState | null>(null);
  const [warned, setWarned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .loadPaperwork(load.id)
      .then((result) => {
        if (!cancelled) setState(result.data);
      })
      .catch(() => {
        if (!cancelled) setNote("Couldn't check this load's paperwork.");
      });
    return () => {
      cancelled = true;
    };
  }, [load.id]);

  async function complete() {
    setBusy(true);
    try {
      await apiClient.update<Load>("loads", load.id, { status: "completed" });
      onCompleted();
    } catch {
      setNote("Couldn't complete the load. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Paperwork">
      <h2>Paperwork</h2>
      {state && (
        <>
          <ul>
            {state.items.map((item) => (
              <li key={item.kind}>
                {item.present ? "✓" : "✗"} {item.label}
                {!item.present && <span className="row-sub"> — {item.why}</span>}
              </li>
            ))}
          </ul>
          <p className="row-sub">{state.summaryLine}</p>
        </>
      )}
      {load.status !== "completed" &&
        (warned && state && !state.complete ? (
          <p role="alert">
            {state.summaryLine}{" "}
            <button type="button" disabled={busy} onClick={complete}>
              Complete anyway
            </button>
          </p>
        ) : (
          <button
            type="button"
            disabled={busy || !state}
            onClick={() => {
              if (state && !state.complete) setWarned(true);
              else void complete();
            }}
          >
            Mark load completed
          </button>
        ))}
      {note && <p role="alert">{note}</p>}
    </section>
  );
}

export default function LoadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Load");
  const [load, setLoad] = useState<Load | null>(null);
  const [error, setError] = useState<string | null>(null);

  const expenses = useApiList<Expense>("expenses", { load_id: id });
  const duty = useApiList<DutyLog>("duty-logs", { load_id: id });

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Load>("loads", id)
      .then((row) => {
        if (!cancelled) setLoad(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this load. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Load" purpose="One load, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!load) {
    return (
      <div>
        <PageHeader title="Load" purpose="One load, in full." />
        <ListLoading />
      </div>
    );
  }

  const expenseRows = expenses.state.status === "loaded" ? expenses.state.result.data : [];
  const dutyRows = duty.state.status === "loaded" ? duty.state.result.data : [];
  const expenseCost = expenseRows.reduce((sum, row) => sum + row.amount_cents, 0);

  return (
    <div>
      <PageHeader
        title={`${load.origin} → ${load.destination}`}
        purpose={`Load — ${load.status}. Everything recorded against it, in one place.`}
        action={
          <Link href={`/smart-path?load_id=${load.id}`} className="page-action">
            Route check
          </Link>
        }
      />

      <section aria-label="Load facts">
        <h2>The load</h2>
        <dl>
          <dt>Rate</dt>
          <dd>{load.rate_cents != null ? formatDollars(load.rate_cents) : "—"}</dd>
          <dt>Miles</dt>
          <dd>{load.miles != null ? load.miles.toLocaleString("en-US") : "—"}</dd>
          <dt>Per mile</dt>
          <dd>
            {load.rate_cents != null && load.miles != null && load.miles > 0
              ? `$${(load.rate_cents / 100 / load.miles).toFixed(2)}`
              : "—"}
          </dd>
          <dt>Expenses on it</dt>
          <dd>{expenseCost > 0 ? formatDollars(expenseCost) : "—"}</dd>
        </dl>
        {(load.pickup_date || load.delivery_date) && (
          <p className="row-sub">
            {load.pickup_date
              ? `Pickup ${new Date(`${load.pickup_date}T12:00:00`).toLocaleDateString()}`
              : ""}
            {load.pickup_date && load.delivery_date ? " · " : ""}
            {load.delivery_date
              ? `Deliver ${new Date(`${load.delivery_date}T12:00:00`).toLocaleDateString()}`
              : ""}
          </p>
        )}
        {(load.pickup_window_start || load.delivery_window_start) && (
          <p className="row-sub">
            {load.pickup_window_start &&
              `Pickup window ${formatStampTime(load.pickup_window_start)} – ${load.pickup_window_end ? formatStampTime(load.pickup_window_end) : "?"}`}
            {load.pickup_window_start && load.delivery_window_start ? " · " : ""}
            {load.delivery_window_start &&
              `Delivery window ${formatStampTime(load.delivery_window_start)} – ${load.delivery_window_end ? formatStampTime(load.delivery_window_end) : "?"}`}
          </p>
        )}
        {load.weight_lbs != null && (
          <p className="row-sub">Weight on the ticket: {load.weight_lbs.toLocaleString("en-US")} lb</p>
        )}
        {load.notes && <p>{load.notes}</p>}
      </section>

      <DetentionSection load={load} />

      <PaperworkSection
        load={load}
        onCompleted={() => window.location.reload()}
      />

      <section aria-label="Expenses on this load">
        <h2>Expenses on this load</h2>
        {expenseRows.length === 0 ? (
          <p className="row-sub">
            No expenses recorded against this load yet — tolls, lumpers, scales belong here so the load&apos;s
            real profit shows.
          </p>
        ) : (
          <ul>
            {expenseRows.map((row) => (
              <li key={row.id}>
                {formatDollars(row.amount_cents)} — {row.category}
                {row.description ? ` — ${row.description}` : ""}{" "}
                <span className="row-sub">
                  {new Date(`${row.expense_date}T12:00:00`).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="This load's records">
        <h2>Paperwork &amp; logs</h2>
        <ul>
          <li>
            <Link href={`/more/documents?related_entity_type=load&related_entity_id=${load.id}`}>
              Documents — BOL, rate con, receipts
            </Link>
          </li>
          <li>
            Duty entries logged on this load: {dutyRows.length}
            {" — "}
            <Link href="/fleet/hos">Open hours of service</Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
