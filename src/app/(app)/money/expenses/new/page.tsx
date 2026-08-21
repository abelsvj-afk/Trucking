"use client";

// Task 3.7 (TASKS.md). Same dollar-to-cents UX pattern as loads/new/page.tsx -
// asking for raw cents would be unusable, per CLAUDE.md's "must be genuinely
// usable" rule.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { Driver, Expense, ExpenseCategory, Load, Truck } from "@/types/entities";

const CATEGORIES: { label: string; value: ExpenseCategory }[] = [
  { label: "Insurance", value: "insurance" },
  { label: "Permits", value: "permits" },
  { label: "Repairs", value: "repairs" },
  { label: "Other", value: "other" },
];

export default function NewExpensePage() {
  usePageTitle("Add expense");
  const router = useRouter();
  const [category, setCategory] = useState<ExpenseCategory>("other");
  const [amountDollars, setAmountDollars] = useState("");
  const [expenseDate, setExpenseDate] = useState("");
  const [truckId, setTruckId] = useState("");
  const [loadId, setLoadId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");
  const loads = usePickerList<Load>("loads");
  const drivers = usePickerList<Driver>("drivers");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<Expense>("expenses", {
        category,
        amount_cents: Math.round(parseFloat(amountDollars || "0") * 100),
        expense_date: expenseDate,
        truck_id: truckId || null,
        load_id: loadId || null,
        driver_id: driverId || null,
        description: description || undefined,
      });
      router.push("/money/expenses");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Add expense</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="category">Category</label>
        <select
          id="category"
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

        <label htmlFor="amount">Amount ($)</label>
        <input
          id="amount"
          type="number"
          step="0.01"
          min="0"
          value={amountDollars}
          onChange={(event) => setAmountDollars(event.target.value)}
          required
        />

        <label htmlFor="expense_date">Date</label>
        <input
          id="expense_date"
          type="date"
          value={expenseDate}
          onChange={(event) => setExpenseDate(event.target.value)}
          required
        />

        <label htmlFor="truck_id">Truck</label>
        <select id="truck_id" value={truckId} onChange={(event) => setTruckId(event.target.value)}>
          <option value="">Unassigned</option>
          {trucks.map((truck) => (
            <option key={truck.id} value={truck.id}>
              {truck.unit_number}
            </option>
          ))}
        </select>

        <label htmlFor="load_id">Load</label>
        <select id="load_id" value={loadId} onChange={(event) => setLoadId(event.target.value)}>
          <option value="">Unassigned</option>
          {loads.map((load) => (
            <option key={load.id} value={load.id}>
              {load.origin} → {load.destination}
            </option>
          ))}
        </select>

        <label htmlFor="driver_id">Driver</label>
        <select id="driver_id" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
          <option value="">Unassigned</option>
          {drivers.map((driver) => (
            <option key={driver.id} value={driver.id}>
              {driver.name}
            </option>
          ))}
        </select>

        <label htmlFor="description">Description</label>
        <input
          id="description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
