"use client";

// Task 3.2 (TASKS.md). Same pattern as fleet/trucks/page.tsx.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import type { Trailer } from "@/types/entities";

export default function TrailersListPage() {
  usePageTitle("Trailers");
  const { state, retry } = useApiList<Trailer>("trailers");

  return (
    <div>
      <h1>Trailers</h1>
      <Link href="/fleet/trailers/new">Add trailer</Link>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <ListEmpty
          message="No trailers yet — add your first one."
          action={<Link href="/fleet/trailers/new">Add trailer</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((trailer) => (
            <li key={trailer.id}>
              {trailer.unit_number} — {trailer.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
