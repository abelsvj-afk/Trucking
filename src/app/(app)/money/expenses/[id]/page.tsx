"use client";

// Reliability Unit A: the expense's own screen. Before this, an
// expense was a line in a list with no way to see it in full, fix a
// typo'd amount, or delete it. Here: the expense's facts up top, an
// edit form mirroring the Add expense fields (PATCH on save), and the
// delete control at the bottom.

import {use, useEffect, useState} from "react";
import Link from "next/link";
import {apiClient} from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import Sheet from "@/components/Sheet";
import ExpenseEditForm from "@/components/edit/ExpenseEditForm";
import {ListLoading, ListError} from "@/components/ListStates";
import {DeleteRecordButton} from "@/components/RecordLifecycle";
import {usePageTitle} from "@/lib/use-page-title";
import {formatDollars} from "@/lib/truck-fund";
import ExpenseBucketField from "@/components/ExpenseBucketField";
import EntityDocuments from "@/components/EntityDocuments";
import {bucketOf} from "@/lib/expense-buckets";
import type {Expense} from "@/types/entities";

const CATEGORY_LABELS: Record<Expense["category"], string> = {
  insurance: "Insurance",
  permits: "Permits",
  repairs: "Repairs",
  other: "Other",
};

export default function ExpenseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Expense");
  const [expense, setExpense] = useState<Expense | null>(null);
  const [editOpen, setEditOpen] = useState(false);
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
      
        action={
          <button type="button" className="page-action" onClick={() => setEditOpen(true)}>
            Edit
          </button>
        }
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

      {editOpen && (
          <Sheet title="Edit expense" onClose={() => setEditOpen(false)}>
            <ExpenseEditForm key={expense.id} expense={expense} onSaved={(updated) => { setExpense(updated); setEditOpen(false); }} />
          </Sheet>
        )}

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
