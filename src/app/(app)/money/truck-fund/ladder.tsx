"use client";

// Business finance ladder section (docs/design/driver-mvp.md §9.4,
// vision §8). Static knowledge + owner-set state: each rung shows
// what it is in one plain line, its state, and the next action. The
// order is a guide, not a lock - a rung started before its
// predecessors are done is flagged "started early," never blocked.

import { useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import type { LadderStepState } from "@/lib/truck-fund";
import type { LadderStepView } from "@/types/truck-fund";

const STATE_LABELS: Record<LadderStepState, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
};

export default function LadderSection({
  steps,
  onChanged,
}: {
  steps: LadderStepView[];
  onChanged: () => void | Promise<void>;
}) {
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setState(step: LadderStepView, state: LadderStepState) {
    setError(null);
    setSavingKey(step.step_key);
    try {
      await apiClient.updateLadderStep(step.step_key, { state, note: step.note });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save that step. Try again.");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <section aria-labelledby="ladder-heading">
      <h2 id="ladder-heading">Business credit ladder</h2>
      <p>
        The boxes between an LLC on paper and real business credit, in the order they unlock each
        other. Mark each one as you go — starting one early is fine, it&apos;s just flagged so the
        picture stays honest.
      </p>
      {error && (
        <div role="alert">
          <p>{error}</p>
        </div>
      )}
      <ol>
        {steps.map((step) => (
          <li key={step.step_key}>
            <h3>
              {step.title} — {STATE_LABELS[step.state]}
            </h3>
            <p>{step.what_it_is}</p>
            <p>
              <strong>Next action:</strong> {step.next_action}
            </p>
            {step.note && <p>Note: {step.note}</p>}
            {!step.unlocked && step.state === "not_started" && (
              <p>Waiting on the rungs above it.</p>
            )}
            {step.out_of_order && <p>Started early — earlier rungs aren&apos;t done yet.</p>}
            <div>
              {(Object.keys(STATE_LABELS) as LadderStepState[]).map((state) => (
                <button
                  key={state}
                  type="button"
                  disabled={savingKey === step.step_key || step.state === state}
                  onClick={() => setState(step, state)}
                >
                  {STATE_LABELS[state]}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
