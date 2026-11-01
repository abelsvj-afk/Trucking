"use client";

// Task 3.7 (TASKS.md), UI/UX upgrade: purpose header, teaching empty
// state, and rows that lead with the amount and date instead of one
// run-on string.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import type { Expense } from "@/types/entities";

const CATEGORY_LABELS: Record<Expense["category"], string> = {
  insurance: "Insurance",
  permits: "Permits",
  repairs: "Repairs",
  other: "Other",
};

export default function ExpensesListPage() {
  usePageTitle("Expenses");
  const { state, retry } = useApiList<Expense>("expenses");

  return (
    <div>
      <PageHeader
        title="Expenses"
        purpose="What the business spends — every cost logged is a cost the summary and the assistant can count."
        action={
          <Link href="/money/expenses/new" className="page-action">
            Add expense
          </Link>
        }
      />

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <TeachingEmpty
          title="No expenses yet"
          message="Log what the truck costs you — insurance, permits, repairs, tolls. Expenses are half of knowing whether a load actually paid."
          action={<Link href="/money/expenses/new">Add your first expense</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((expense) => (
            <li key={expense.id}>
              <span className="row-title">
                ${(expense.amount_cents / 100).toFixed(2)} — {CATEGORY_LABELS[expense.category]}
              </span>
              <span className="row-sub">
                {new Date(`${expense.expense_date}T12:00:00`).toLocaleDateString()}
                {expense.description ? ` · ${expense.description}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
