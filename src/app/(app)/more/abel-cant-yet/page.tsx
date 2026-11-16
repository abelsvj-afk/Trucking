"use client";

// "What Abel can't do yet" (docs/design/abel-do-what-i-ask.md section 1). Every ask Abel had no tool for, in his
// words, with how many times he asked - the build backlog. "Drop it" removes one from the list; nothing else here
// changes any record.

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError, type CapabilityGapItem } from "@/lib/api-client";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import { formatDateTime } from "@/lib/time";

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; gaps: CapabilityGapItem[]; ready: boolean };

export default function AbelCantYetPage() {
  usePageTitle("What Abel can't do yet");
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    apiClient
      .listCapabilityGaps()
      .then((r) => setState({ status: "loaded", gaps: r.data, ready: r.ready }))
      .catch((err: unknown) =>
        setState({ status: "error", message: err instanceof ApiClientError ? err.message : "Couldn't load the list." }),
      );
  }, []);
  useEffect(load, [load]);

  async function drop(id: string) {
    setBusyId(id);
    try {
      await apiClient.dismissCapabilityGap(id);
      load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main>
      <PageHeader
        title="What Abel can't do yet"
        purpose="When you ask Abel for something it can't do, it tells you and writes your ask here. This is the list of what to build next."
      />
      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={load} />}
      {state.status === "loaded" && !state.ready && (
        <p role="status">This list isn&apos;t switched on yet: its database update still needs to be applied.</p>
      )}
      {state.status === "loaded" && state.ready && state.gaps.length === 0 && <p>Nothing here. Everything you&apos;ve asked for, Abel could do.</p>}
      {state.status === "loaded" && state.gaps.length > 0 && (
        <ul>
          {state.gaps.map((gap) => (
            <li key={gap.id}>
              <strong>{gap.missing}</strong>
              <p>
                You asked: &ldquo;{gap.asked}&rdquo;
                {gap.times_asked > 1 ? ` (${gap.times_asked} times)` : ""} · {formatDateTime(gap.last_asked_at)}
              </p>
              <button type="button" className="button-danger-quiet" disabled={busyId === gap.id} onClick={() => void drop(gap.id)}>
                Drop it
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
