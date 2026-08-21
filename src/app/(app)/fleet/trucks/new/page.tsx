"use client";

// Task 3.1 (TASKS.md). New truck form. Field-level errors render inline,
// per docs/design/ui-ux.md's Errors section - never a raw error code.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import type { Truck } from "@/types/entities";

export default function NewTruckPage() {
  usePageTitle("Add truck");
  const router = useRouter();
  const [unitNumber, setUnitNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<Truck>("trucks", { unit_number: unitNumber });
      router.push("/fleet/trucks");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Add truck</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="unit_number">Unit number</label>
        <input
          id="unit_number"
          value={unitNumber}
          onChange={(event) => setUnitNumber(event.target.value)}
          required
        />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
