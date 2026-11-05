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
//
// Reliability Unit A (F-016/F-028): this screen is also where a load's
// record is actually maintained - the edit form below PATCHes through
// merged-record validation, and the status section moves the load
// through its lifecycle (draft -> confirmed -> completed, or
// cancelled) behind the server's completeness rules: confirming needs
// rate + pickup + delivery dates, completing needs a delivery date.
// A refusal comes back as a named 422 and is shown as-is.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import LoadDocuments from "@/components/LoadDocuments";
import { DeleteRecordButton } from "@/components/RecordLifecycle";
import { useApiList } from "@/lib/use-api-list";
import { useLiveVersion } from "@/lib/use-live";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { Broker, Customer, DetentionStamp, Driver, DutyLog, Expense, Load, LoadStatus, LoadStop, LoadTask, Trailer, Truck } from "@/types/entities";
import type { DetentionSummary } from "@/lib/detention";
import type { PaperworkState } from "@/lib/paperwork";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

/** An appointment in the zone it was written in (the facility's), labeled - never silently the phone's. */
function formatInZone(iso: string, zone: string | null | undefined) {
  if (!zone) return formatStampTime(iso);
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
  } catch {
    return formatStampTime(iso);
  }
}

/** Each stop with its appointment in the facility's zone, and progress the owner records by tapping. */
function StopsSection({ loadId }: { loadId: string }) {
  const version = useLiveVersion(["load_stops"]);
  const [stops, setStops] = useState<LoadStop[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiClient
      .list<LoadStop>("load-stops", { load_id: loadId })
      .then((r) => { if (!cancelled) setStops([...r.data].sort((a, b) => a.seq - b.seq)); })
      .catch(() => { if (!cancelled) setNote("Couldn't load the stops."); });
    return () => { cancelled = true; };
  }, [loadId, version]);
  if (note) return <p role="alert">{note}</p>;
  if (!stops || stops.length === 0) return null;
  async function mark(stop: LoadStop, field: "arrived_at" | "departed_at" | "approved_at") {
    setNote(null);
    try {
      const updated = await apiClient.update<LoadStop>("load-stops", stop.id, { [field]: stop[field] ? null : new Date().toISOString() });
      setStops((prev) => (prev ? prev.map((s) => (s.id === stop.id ? { ...s, ...updated } : s)) : prev));
    } catch {
      setNote("Couldn't save that. Try again.");
    }
  }
  const when = (iso: string | null) => (iso ? formatStampTime(iso) : null);
  return (
    <section aria-label="Stops">
      <h2>Stops</h2>
      <ol className="record-list">
        {stops.map((s) => (
          <li key={s.id}>
            <strong>{s.kind === "pickup" ? "Pickup" : s.kind === "delivery" ? "Delivery" : "Stop"} {s.seq}</strong>
            {s.name ? ` — ${s.name}` : ""}
            {s.address && <div className="row-sub">{s.address}</div>}
            {s.appointment_at && <div className="row-sub">Appointment {formatInZone(s.appointment_at, s.appointment_tz)}</div>}
            <div className="row-sub">
              {s.arrived_at ? `Arrived ${when(s.arrived_at)}` : "Not arrived"} ·{" "}
              {s.approved_at ? `Dispatcher approved ${when(s.approved_at)}` : "No dispatcher approval recorded"} ·{" "}
              {s.departed_at ? `Left ${when(s.departed_at)}` : "Not left"}
            </div>
            <div>
              <button type="button" onClick={() => void mark(s, "arrived_at")}>{s.arrived_at ? "Undo arrived" : "I arrived"}</button>{" "}
              <button type="button" onClick={() => void mark(s, "approved_at")}>{s.approved_at ? "Undo approval" : "Dispatcher approved"}</button>{" "}
              <button type="button" onClick={() => void mark(s, "departed_at")}>{s.departed_at ? "Undo left" : "I left"}</button>
            </div>
          </li>
        ))}
      </ol>
      <p className="row-sub">These are set only when you tap them. Approval is never assumed.</p>
    </section>
  );
}

/** The dispatcher's requirements for this trip; a task is done only when he marks it. */
function TripTasksSection({ loadId }: { loadId: string }) {
  const version = useLiveVersion(["load_tasks"]);
  const [tasks, setTasks] = useState<LoadTask[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiClient
      .list<LoadTask>("load-tasks", { load_id: loadId })
      .then((r) => { if (!cancelled) setTasks([...r.data].sort((a, b) => a.sort_order - b.sort_order)); })
      .catch(() => { if (!cancelled) setNote("Couldn't load the trip tasks."); });
    return () => { cancelled = true; };
  }, [loadId, version]);
  if (note) return <p role="alert">{note}</p>;
  if (!tasks || tasks.length === 0) return null;
  async function toggle(task: LoadTask) {
    setNote(null);
    try {
      const updated = await apiClient.update<LoadTask>("load-tasks", task.id, { done_at: task.done_at ? null : new Date().toISOString() });
      setTasks((prev) => (prev ? prev.map((t) => (t.id === task.id ? { ...t, ...updated } : t)) : prev));
    } catch {
      setNote("Couldn't save that. Try again.");
    }
  }
  return (
    <section aria-label="Trip tasks">
      <h2>Trip tasks</h2>
      <ul className="record-list">
        {tasks.map((t) => (
          <li key={t.id}>
            <label>
              <input type="checkbox" checked={Boolean(t.done_at)} onChange={() => void toggle(t)} /> {t.text}
              {t.stop_kind && t.stop_kind !== "every_stop" ? ` (${t.stop_kind})` : ""}
            </label>
          </li>
        ))}
      </ul>
      <p className="row-sub">A task is done only when you tick it. The dispatcher&apos;s approval is never assumed.</p>
    </section>
  );
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

  const assignedTrucks = usePickerList<Truck>("trucks");
  const assignedTrailers = usePickerList<Trailer>("trailers");
  const expenses = useApiList<Expense>("expenses", { load_id: id });
  const duty = useApiList<DutyLog>("duty-logs", { load_id: id });
  // Live layer: a change to loads (Abel, another tab) re-reads this one.
  const liveVersion = useLiveVersion(["loads"]);

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
  }, [id, liveVersion]);

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
          {load.trip_number && (<><dt>Trip</dt><dd>{load.trip_number}</dd></>)}
          {(load.truck_id || load.trailer_id) && (
            <>
              <dt>Equipment</dt>
              <dd>
                {[
                  load.truck_id ? `Truck ${assignedTrucks.find((t) => t.id === load.truck_id)?.unit_number ?? ""}`.trim() : null,
                  load.trailer_id ? `Trailer ${assignedTrailers.find((t) => t.id === load.trailer_id)?.unit_number ?? ""}`.trim() : null,
                ].filter(Boolean).join(" · ")}
              </dd>
            </>
          )}
          {load.broker_reference && (<><dt>Broker ref</dt><dd>{load.broker_reference}</dd></>)}
          <dt>Rate</dt>
          <dd>{load.rate_cents != null ? formatDollars(load.rate_cents) : "—"}</dd>
          <dt>Miles</dt>
          <dd>{load.miles != null ? load.miles.toLocaleString("en-US") : "—"}</dd>
          {(load.deadhead_miles != null || load.loaded_miles != null) && (
            <>
              <dt>Deadhead / loaded</dt>
              <dd>
                {load.deadhead_miles != null ? `${load.deadhead_miles.toFixed(2)} mi` : "—"} /{" "}
                {load.loaded_miles != null ? `${load.loaded_miles.toFixed(2)} mi` : "—"}
              </dd>
            </>
          )}
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
              `Pickup window ${formatInZone(load.pickup_window_start, load.pickup_tz)} – ${load.pickup_window_end ? formatInZone(load.pickup_window_end, load.pickup_tz) : "?"}`}
            {load.pickup_window_start && load.delivery_window_start ? " · " : ""}
            {load.delivery_window_start &&
              `Delivery window ${formatInZone(load.delivery_window_start, load.delivery_tz)} – ${load.delivery_window_end ? formatInZone(load.delivery_window_end, load.delivery_tz) : "?"}`}
          </p>
        )}
        {load.weight_lbs != null && (
          <p className="row-sub">Weight on the ticket: {load.weight_lbs.toLocaleString("en-US")} lb</p>
        )}
        {load.notes && <p>{load.notes}</p>}
      </section>

      <LoadStatusSection key={`status-${load.id}-${load.status}`} load={load} onChanged={setLoad} />

      <StopsSection loadId={load.id} />

      <TripTasksSection loadId={load.id} />

      <DetentionSection load={load} />

      <LoadDocuments loadId={load.id} />

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

      <LoadEditForm key={`edit-${load.id}`} load={load} onSaved={setLoad} />

      <section aria-label="Delete this load">
        <h2>Delete this load</h2>
        <DeleteRecordButton
          resource="loads"
          id={load.id}
          recordName={`Load ${load.origin} → ${load.destination}`}
          listHref="/loads"
          listLabel="loads"
        />
      </section>
    </div>
  );
}

// Draft-completeness checklist + status transitions (design A.4): the
// checklist shows what confirming still needs BEFORE the tap; the
// server enforces the same rules on the merged record and its 422
// names anything still missing.
function LoadStatusSection({
  load,
  onChanged,
}: {
  load: Load;
  onChanged: (load: Load) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checklist = [
    { label: "Rate", ok: load.rate_cents != null },
    { label: "Pickup date", ok: Boolean(load.pickup_date) },
    { label: "Delivery date", ok: Boolean(load.delivery_date) },
  ];
  const readyToConfirm = checklist.every((item) => item.ok);

  async function transition(status: LoadStatus) {
    setError(null);
    setBusy(true);
    try {
      const updated = await apiClient.update<Load>("loads", load.id, { status });
      onChanged(updated);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't update this load. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Load status">
      <h2>Status — {load.status}</h2>
      {load.status === "draft" && (
        <div>
          <p className="row-sub">
            {readyToConfirm
              ? "This draft has everything confirming needs."
              : "Still needed before this load can be confirmed:"}
          </p>
          <ul>
            {checklist.map((item) => (
              <li key={item.label}>
                {item.ok ? "✓" : "✗"} {item.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        {load.status !== "confirmed" && load.status !== "completed" && (
          <button type="button" disabled={busy} onClick={() => transition("confirmed")}>
            Confirm load
          </button>
        )}{" "}
        {load.status !== "completed" && (
          <button type="button" disabled={busy} onClick={() => transition("completed")}>
            Mark completed
          </button>
        )}{" "}
        {load.status !== "cancelled" && load.status !== "completed" && (
          <button type="button" disabled={busy} onClick={() => transition("cancelled")}>
            Cancel load
          </button>
        )}{" "}
        {(load.status === "cancelled" || load.status === "completed") && (
          <button type="button" disabled={busy} onClick={() => transition("draft")}>
            Back to draft
          </button>
        )}
      </p>
    </section>
  );
}

function LoadEditForm({ load, onSaved }: { load: Load; onSaved: (load: Load) => void }) {
  const [origin, setOrigin] = useState(load.origin);
  const [destination, setDestination] = useState(load.destination);
  const [pickupDate, setPickupDate] = useState(load.pickup_date ?? "");
  const [deliveryDate, setDeliveryDate] = useState(load.delivery_date ?? "");
  const [rateDollars, setRateDollars] = useState(
    load.rate_cents != null ? (load.rate_cents / 100).toString() : "",
  );
  const [miles, setMiles] = useState(load.miles != null ? load.miles.toString() : "");
  const [loadedMiles, setLoadedMiles] = useState(load.loaded_miles != null ? load.loaded_miles.toString() : "");
  const [deadheadMiles, setDeadheadMiles] = useState(load.deadhead_miles != null ? load.deadhead_miles.toString() : "");
  const [notes, setNotes] = useState(load.notes ?? "");
  const [truckId, setTruckId] = useState(load.truck_id ?? "");
  const [trailerId, setTrailerId] = useState(load.trailer_id ?? "");
  const [driverId, setDriverId] = useState(load.driver_id ?? "");
  const [brokerId, setBrokerId] = useState(load.broker_id ?? "");
  const [customerId, setCustomerId] = useState(load.customer_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const drivers = usePickerList<Driver>("drivers");
  const brokers = usePickerList<Broker>("brokers");
  const customers = usePickerList<Customer>("customers");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<Load>("loads", load.id, {
        origin,
        destination,
        pickup_date: pickupDate || null,
        delivery_date: deliveryDate || null,
        rate_cents: rateDollars ? Math.round(parseFloat(rateDollars) * 100) : null,
        miles: miles ? Math.round(parseFloat(miles)) : null,
        // Only when filled in and changed (the columns are not clearable here).
        ...(loadedMiles && loadedMiles !== (load.loaded_miles?.toString() ?? "") ? { loaded_miles: parseFloat(loadedMiles) } : {}),
        ...(deadheadMiles && deadheadMiles !== (load.deadhead_miles?.toString() ?? "") ? { deadhead_miles: parseFloat(deadheadMiles) } : {}),
        notes: notes || null,
        truck_id: truckId || null,
        // Only when changed: an untouched trailer never writes the column.
        ...(trailerId !== (load.trailer_id ?? "") ? { trailer_id: trailerId || null } : {}),
        driver_id: driverId || null,
        broker_id: brokerId || null,
        customer_id: customerId || null,
      });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
        setFieldErrors(err.fields ?? []);
      } else {
        setError("Couldn't save. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="Edit this load">
      <h2>Edit this load</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="edit-origin">Origin</label>
        <input id="edit-origin" value={origin} onChange={(event) => setOrigin(event.target.value)} required />

        <label htmlFor="edit-destination">Destination</label>
        <input
          id="edit-destination"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          required
        />

        <label htmlFor="edit-pickup_date">Pickup date</label>
        <input
          id="edit-pickup_date"
          type="date"
          value={pickupDate}
          onChange={(event) => setPickupDate(event.target.value)}
        />

        <label htmlFor="edit-delivery_date">Delivery date</label>
        <input
          id="edit-delivery_date"
          type="date"
          value={deliveryDate}
          onChange={(event) => setDeliveryDate(event.target.value)}
        />

        <label htmlFor="edit-rate">Rate ($)</label>
        <input
          id="edit-rate"
          type="number"
          step="0.01"
          min="0"
          value={rateDollars}
          onChange={(event) => setRateDollars(event.target.value)}
        />

        <label htmlFor="edit-miles">Miles</label>
        <input
          id="edit-miles"
          type="number"
          step="1"
          min="0"
          value={miles}
          onChange={(event) => setMiles(event.target.value)}
        />

        <label htmlFor="edit-loaded-miles">Loaded miles</label>
        <input id="edit-loaded-miles" type="number" step="0.1" min="0" value={loadedMiles} onChange={(event) => setLoadedMiles(event.target.value)} />

        <label htmlFor="edit-deadhead-miles">Deadhead miles</label>
        <input id="edit-deadhead-miles" type="number" step="0.1" min="0" value={deadheadMiles} onChange={(event) => setDeadheadMiles(event.target.value)} />

        <label htmlFor="edit-truck_id">Truck</label>
        <select id="edit-truck_id" value={truckId} onChange={(event) => setTruckId(event.target.value)}>
          <option value="">Unassigned</option>
          {trucks.map((truck) => (
            <option key={truck.id} value={truck.id}>
              {truck.unit_number}
            </option>
          ))}
        </select>

        <label htmlFor="edit-trailer_id">Trailer</label>
        <select id="edit-trailer_id" value={trailerId} onChange={(event) => setTrailerId(event.target.value)}>
          <option value="">Unassigned</option>
          {trailers.map((trailer) => (
            <option key={trailer.id} value={trailer.id}>
              {trailer.unit_number}
            </option>
          ))}
        </select>

        <label htmlFor="edit-driver_id">Driver</label>
        <select id="edit-driver_id" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
          <option value="">Unassigned</option>
          {drivers.map((driver) => (
            <option key={driver.id} value={driver.id}>
              {driver.name}
            </option>
          ))}
        </select>

        <label htmlFor="edit-broker_id">Broker</label>
        <select id="edit-broker_id" value={brokerId} onChange={(event) => setBrokerId(event.target.value)}>
          <option value="">None</option>
          {brokers.map((broker) => (
            <option key={broker.id} value={broker.id}>
              {broker.name}
            </option>
          ))}
        </select>

        <label htmlFor="edit-customer_id">Customer</label>
        <select id="edit-customer_id" value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
          <option value="">None</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>

        <label htmlFor="edit-notes">Notes</label>
        <input id="edit-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />

        {error && <p role="alert">{error}</p>}
        {fieldErrors.length > 0 && (
          <ul role="alert">
            {fieldErrors.map((field) => (
              <li key={`${field.path}-${field.message}`}>
                {field.path}: {field.message}
              </li>
            ))}
          </ul>
        )}
        {saved && <p role="status">Saved.</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
      </form>
    </section>
  );
}
