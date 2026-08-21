"use client";

// Task 3.6 (TASKS.md). Per docs/design/ui-ux.md: filterable by status,
// draft loads visibly badged so it's never ambiguous which loads are
// missing information.

import Link from "next/link";
import { useState } from "react";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import type { Load, LoadStatus } from "@/types/entities";

const STATUS_FILTERS: { label: string; value: LoadStatus | "" }[] = [
  { label: "All", value: "" },
  { label: "Draft", value: "draft" },
  { label: "Confirmed", value: "confirmed" },
  { label: "Completed", value: "completed" },
];

export default function LoadsListPage() {
  usePageTitle("Loads");
  const [statusFilter, setStatusFilter] = useState<LoadStatus | "">("");
  const { state, retry } = useApiList<Load>(
    "loads",
    statusFilter ? { status: statusFilter } : undefined,
  );

  return (
    <div>
      <h1>Loads</h1>
      <Link href="/loads/new">Add load</Link>

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
        <ListEmpty
          message="No loads yet — add your first one."
          action={<Link href="/loads/new">Add load</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((load) => (
            <li key={load.id}>
              {load.status === "draft" && <strong>Draft</strong>} {load.origin} → {load.destination}
              {load.rate_cents != null && ` — $${(load.rate_cents / 100).toFixed(2)}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
