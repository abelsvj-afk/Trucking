"use client";

// Reliability Unit A: the expense's own screen. Before this, an
// expense was a line in a list with no way to see it in full, fix a
// typo'd amount, or delete it. Here: the expense's facts up top, an
// edit form mirroring the Add expense fields (PATCH on save), and the
// delete control at the bottom.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { DeleteRecordButton } from "@/components/RecordLifecycle";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import { formatDollars } from "@/lib/truck-fund";
import ExpenseBucketField from "@/components/ExpenseBucketField";
import EntityDocuments from "@/components/EntityDocuments";
import { bucketOf, type ExpenseBucket } from "@/lib/expense-buckets";
import type { Driver, Expense, ExpenseCategory, Load, Truck } from "@/types/entities";

const CATEGORY_LABELS: Record<Expense["category"], string> = {
  insurance: "Insurance",
  permits: "Permits",
  repairs: "Repairs",
  other: "Other",
};

const CATEGORIES: { label: string; value: ExpenseCategory }[] = [
  { label: "Insurance", value: "insurance" },
  { label: "Permits", value: "permits" },
  { label: "Repairs", value: "repairs" },
  { label: "Other", value: "other" },
];

export default function ExpenseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Expense");
  const [expense, setExpense] = useState<Expense | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Expense>("expenses", id)
      .then((row) => {
        if (!cancelled) setExpense(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this expense. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Expense" purpose="One expense, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!expense) {
    return (
      <div>
        <PageHeader title="Expense" purpose="One expense, in full." />
        <ListLoading />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={`${CATEGORY_LABELS[expense.category]} expense`}
        purpose={`${formatDollars(expense.amount_cents)} — its details, and the record controls, in one place.`}
      />

      <section aria-label="Expense facts">
        <h2>The expense</h2>
        <dl>
          <dt>Category</dt>
          <dd>{CATEGORY_LABELS[expense.category]}</dd>
          <dt>Amount</dt>
          <dd>{formatDollars(expense.amount_cents)}</dd>
          <dt>Date</dt>
          <dd>{new Date(`${expense.expense_date}T12:00:00`).toLocaleDateString()}</dd>
          <dt>Description</dt>
          <dd>{expense.description ?? "—"}</dd>
          <dt>Kind of cost</dt>
          <dd>
            {bucketOf(expense) === "pay_deduction"
              ? "Pay deduction — comes out of the check (it shows on the Paychecks page with this description as the reason)"
              : "Business expense — the company's own books; it never touches pay"}
          </dd>
        </dl>
      </section>

      <ExpenseEditForm key={expense.id} expense={expense} onSaved={setExpense} />

      <EntityDocuments entityType="expense" entityId={expense.id} />

      <p>
        <Link href="/money/expenses">Back to expenses</Link>
      </p>

      <section aria-label="Delete this expense">
        <h2>Delete this expense</h2>
        <DeleteRecordButton
          resource="expenses"
          id={expense.id}
          recordName={`${CATEGORY_LABELS[expense.category]} expense (${formatDollars(expense.amount_cents)})`}
          listHref="/money/expenses"
          listLabel="expenses"
        />
      </section>
    </div>
  );
}

function ExpenseEditForm({ expense, onSaved }: { expense: Expense; onSaved: (expense: Expense) => void }) {
  const [category, setCategory] = useState<ExpenseCategory>(expense.category);
  const [bucket, setBucket] = useState<ExpenseBucket>(bucketOf(expense));
  const [amountDollars, setAmountDollars] = useState((expense.amount_cents / 100).toString());
  const [expenseDate, setExpenseDate] = useState(expense.expense_date);
  const [truckId, setTruckId] = useState(expense.truck_id ?? "");
  const [loadId, setLoadId] = useState(expense.load_id ?? "");
  const [driverId, setDriverId] = useState(expense.driver_id ?? "");
  const [description, setDescription] = useState(expense.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");
  const loads = usePickerList<Load>("loads");
  const drivers = usePickerList<Driver>("drivers");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<Expense>("expenses", expense.id, {
        category,
        bucket,
        amount_cents: Math.round(parseFloat(amountDollars || "0") * 100),
        expense_date: expenseDate,
        truck_id: truckId || null,
        load_id: loadId || null,
        driver_id: driverId || null,
        description: description || null,
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
    <section aria-label="Edit this expense">
      <h2>Edit this expense</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="edit-category">Category</label>
        <select
          id="edit-category"
          value={category}
          onChange={(event) => setCategory(event.target.value as ExpenseCategory)}
          required
        >
          {CATEGORIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <ExpenseBucketField id="edit-bucket" value={bucket} onChange={setBucket} />

        <label htmlFor="edit-amount">Amount ($)</label>
        <input
          id="edit-amount"
          type="number"
          step="0.01"
          min="0"
          value={amountDollars}
          onChange={(event) => setAmountDollars(event.target.value)}
          required
        />

        <label htmlFor="edit-expense_date">Date</label>
        <input
          id="edit-expense_date"
          type="date"
          value={expenseDate}
          onChange={(event) => setExpenseDate(event.target.value)}
          required
        />

        <label htmlFor="edit-truck_id">Truck</label>
        <select id="edit-truck_id" value={truckId} onChange={(event) => setTruckId(event.target.value)}>
          <option value="">Unassigned</option>
          {trucks.map((truck) => (
            <option key={truck.id} value={truck.id}>
              {truck.unit_number}
            </option>
          ))}
        </select>

        <label htmlFor="edit-load_id">Load</label>
        <select id="edit-load_id" value={loadId} onChange={(event) => setLoadId(event.target.value)}>
          <option value="">Unassigned</option>
          {loads.map((load) => (
            <option key={load.id} value={load.id}>
              {load.origin} → {load.destination}
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

        <label htmlFor="edit-description">Description</label>
        <input
          id="edit-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />

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
