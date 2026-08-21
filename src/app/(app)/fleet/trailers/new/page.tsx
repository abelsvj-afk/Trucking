"use client";

// Task 3.2 (TASKS.md). Same pattern as fleet/trucks/new/page.tsx.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import type { Trailer } from "@/types/entities";

export default function NewTrailerPage() {
  usePageTitle("Add trailer");
  const router = useRouter();
  const [unitNumber, setUnitNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<Trailer>("trailers", { unit_number: unitNumber });
      router.push("/fleet/trailers");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Add trailer</h1>
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
