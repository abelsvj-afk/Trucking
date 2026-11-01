"use client";

// Task 3.6 (TASKS.md). Per docs/design/ui-ux.md: filterable by status,
// draft loads visibly badged so it's never ambiguous which loads are
// missing information.
//
// UI/UX upgrade: rows carry the load's real shape (lane, rate, miles,
// rate per mile, pickup date) and link to the load's own screen, where
// its fuel, expenses, documents, and logs live together.

import Link from "next/link";
import { useState } from "react";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import AskAssistant from "@/components/AskAssistant";
import { usePageTitle } from "@/lib/use-page-title";
import type { Load, LoadStatus } from "@/types/entities";

const STATUS_FILTERS: { label: string; value: LoadStatus | "" }[] = [
  { label: "All", value: "" },
  { label: "Draft", value: "draft" },
  { label: "Confirmed", value: "confirmed" },
  { label: "Completed", value: "completed" },
];

const STATUS_BADGES: Record<LoadStatus, string> = {
  draft: "unknown",
  confirmed: "ok",
  completed: "paused",
};

export default function LoadsListPage() {
  usePageTitle("Loads");
  const [statusFilter, setStatusFilter] = useState<LoadStatus | "">("");
  const { state, retry } = useApiList<Load>(
    "loads",
    statusFilter ? { status: statusFilter } : undefined,
  );

  return (
    <div>
      <PageHeader
        title="Loads"
        purpose="The freight you're hauling — where it goes, what it pays, and whether the numbers work."
        action={
          <Link href="/loads/new" className="page-action">
            Add load
          </Link>
        }
      />

      <div role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            onClick={() => setStatusFilter(filter.value)}
            aria-pressed={statusFilter === filter.value}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <TeachingEmpty
          title={statusFilter ? "No loads with this status" : "No loads yet"}
          message={
            statusFilter
              ? "Nothing sits in this bucket right now. Switch the filter to see the rest of your loads."
              : "Add your first load — origin, destination, rate. Loads are what revenue, route checks, and per-load profit all hang off."
          }
          action={statusFilter ? undefined : <Link href="/loads/new">Add your first load</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((load) => {
            const facts: string[] = [];
            if (load.rate_cents != null) facts.push(`$${(load.rate_cents / 100).toFixed(2)}`);
            if (load.miles != null) facts.push(`${load.miles.toLocaleString("en-US")} mi`);
            if (load.rate_cents != null && load.miles != null && load.miles > 0) {
              facts.push(`$${(load.rate_cents / 100 / load.miles).toFixed(2)}/mi`);
            }
            if (load.pickup_date) {
              facts.push(
                `Pickup ${new Date(`${load.pickup_date}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })}`,
              );
            }
            return (
              <li key={load.id}>
                <Link href={`/loads/${load.id}`}>
                  <span className="row-title">
                    <strong data-status={STATUS_BADGES[load.status]}>{load.status}</strong>
                    {load.origin} → {load.destination}
                  </span>
                  {facts.length > 0 && <span className="row-sub">{facts.join(" · ")}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <AskAssistant
        heading="King can price and sanity-check a load before you commit:"
        prompts={["Is my next load paying enough per mile?", "What loads do I have coming up?", "What did my best load this month pay per mile?"]}
      />
    </div>
  );
}
