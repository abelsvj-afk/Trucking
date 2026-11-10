"use client";

// ExpenseEditForm — extracted from the Expense detail page (UI/UX Phase 4,
// spec §2.4): ONE form component, two hosts — the detail page's
// Edit Sheet (in-place editing) and the standalone /edit route
// (kept alive for deep links, incl. Abel's). Saving calls the
// caller's onSaved with the updated record; each host decides
// what that means (close the sheet / return to the detail page).

import {useState, type FormEvent} from "react";
import {apiClient, ApiClientError} from "@/lib/api-client";
import {usePickerList} from "@/lib/use-picker-list";
import ExpenseBucketField from "@/components/ExpenseBucketField";
import {bucketOf, type ExpenseBucket} from "@/lib/expense-buckets";
import type {Driver, Expense, ExpenseCategory, Load, Truck} from "@/types/entities";

const CATEGORIES: { label: string; value: ExpenseCategory }[] = [
  { label: "Insurance", value: "insurance" },
  { label: "Permits", value: "permits" },
  { label: "Repairs", value: "repairs" },
  { label: "Other", value: "other" },
];

export default function ExpenseEditForm({ expense, onSaved }: { expense: Expense; onSaved: (expense: Expense) => void }) {
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
