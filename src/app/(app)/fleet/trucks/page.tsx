"use client";

// Task 3.1 (TASKS.md). Trucks list, per docs/design/ui-ux.md: loading /
// empty / populated / error states, all four - not just the happy path.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import type { Truck } from "@/types/entities";

export default function TrucksListPage() {
  const { state, retry } = useApiList<Truck>("trucks");

  return (
    <div>
      <h1>Trucks</h1>
      <Link href="/fleet/trucks/new">Add truck</Link>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <ListEmpty
          message="No trucks yet — add your first one."
          action={<Link href="/fleet/trucks/new">Add truck</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((truck) => (
            <li key={truck.id}>
              {truck.unit_number} — {truck.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
