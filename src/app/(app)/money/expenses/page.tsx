"use client";

// Task 3.7 (TASKS.md), UI/UX upgrade: purpose header, teaching empty
// state, and rows that lead with the amount and date instead of one
// run-on string.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import {
  useDeletedToggle,
  DeletedToggleButton,
  DeletedListSection,
} from "@/components/RecordLifecycle";
import { formatDollars } from "@/lib/truck-fund";
import { bucketOf } from "@/lib/expense-buckets";
import type { Expense } from "@/types/entities";

const CATEGORY_LABELS: Record<Expense["category"], string> = {
  insurance: "Insurance",
  permits: "Permits",
  repairs: "Repairs",
  other: "Other",
};

export default function ExpensesListPage() {
  usePageTitle("Expenses");
  const [showDeleted, setShowDeleted] = useDeletedToggle();
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

      <DeletedToggleButton showDeleted={showDeleted} onChange={setShowDeleted} listLabel="expenses" />

      {showDeleted ? (
        <DeletedListSection
          resource="expenses"
          labelFor={(expense: Expense) =>
            `${CATEGORY_LABELS[expense.category]} — ${formatDollars(expense.amount_cents)} — ${new Date(
              `${expense.expense_date}T12:00:00`,
            ).toLocaleDateString()}`
          }
          sublabelFor={(expense: Expense) => expense.description ?? null}
        />
      ) : (
        <>
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
        <>
          {/* The two buckets, side by side: business costs in the books, pay deductions out of the check. */}
          <p role="note">
            Business expenses:{" "}
            {formatDollars(
              state.result.data
                .filter((e) => bucketOf(e) === "business")
                .reduce((sum, e) => sum + e.amount_cents, 0),
            )}{" "}
            · Pay deductions (out of the check):{" "}
            {formatDollars(
              state.result.data
                .filter((e) => bucketOf(e) === "pay_deduction")
                .reduce((sum, e) => sum + e.amount_cents, 0),
            )}
          </p>
          <ul>
            {/* Newest by the expense's own date, not by when it was typed in - a back-dated entry must not sit above this month's. */}
            {[...state.result.data].sort((a, b) => b.expense_date.localeCompare(a.expense_date)).map((expense) => (
              <li key={expense.id}>
                <Link href={`/money/expenses/${expense.id}`}>
                  <span className="row-title">
                    ${(expense.amount_cents / 100).toFixed(2)} — {CATEGORY_LABELS[expense.category]}
                  </span>
                  <span className="row-sub">
                    {new Date(`${expense.expense_date}T12:00:00`).toLocaleDateString()}
                    {expense.description ? ` · ${expense.description}` : ""}
                    {bucketOf(expense) === "pay_deduction" ? " · Pay deduction — out of the check" : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
        </>
      )}
    </div>
  );
}
