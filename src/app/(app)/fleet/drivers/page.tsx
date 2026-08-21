"use client";

// Task 3.3 (TASKS.md). Same pattern as fleet/trucks/page.tsx.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import type { Driver } from "@/types/entities";

export default function DriversListPage() {
  const { state, retry } = useApiList<Driver>("drivers");

  return (
    <div>
      <h1>Drivers</h1>
      <Link href="/fleet/drivers/new">Add driver</Link>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <ListEmpty
          message="No drivers yet — add your first one."
          action={<Link href="/fleet/drivers/new">Add driver</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((driver) => (
            <li key={driver.id}>
              {driver.name} — {driver.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
