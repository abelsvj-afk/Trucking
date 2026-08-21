"use client";

// Task 3.5 (TASKS.md). Same pattern as more/customers/new/page.tsx.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import type { Broker } from "@/types/entities";

export default function NewBrokerPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [mcNumber, setMcNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<Broker>("brokers", {
        name,
        mc_number: mcNumber || undefined,
      });
      router.push("/more/brokers");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Add broker</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="name">Name</label>
        <input id="name" value={name} onChange={(event) => setName(event.target.value)} required />

        <label htmlFor="mc_number">MC number</label>
        <input
          id="mc_number"
          value={mcNumber}
          onChange={(event) => setMcNumber(event.target.value)}
        />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
