"use client";

// Task 3.7 (TASKS.md). Same pattern as loads/page.tsx (list + add link).

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import type { Expense } from "@/types/entities";

const CATEGORY_LABELS: Record<Expense["category"], string> = {
  insurance: "Insurance",
  permits: "Permits",
  repairs: "Repairs",
  other: "Other",
};

export default function ExpensesListPage() {
  const { state, retry } = useApiList<Expense>("expenses");

  return (
    <div>
      <h1>Expenses</h1>
      <Link href="/money/expenses/new">Add expense</Link>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <ListEmpty
          message="No expenses yet — add your first one."
          action={<Link href="/money/expenses/new">Add expense</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((expense) => (
            <li key={expense.id}>
              {expense.expense_date} — {CATEGORY_LABELS[expense.category]} — $
              {(expense.amount_cents / 100).toFixed(2)}
              {expense.description && ` (${expense.description})`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
