"use client";

// BrokerEditForm — extracted from the Broker detail page (UI/UX Phase 4,
// spec §2.4): ONE form component, two hosts — the detail page's
// Edit Sheet (in-place editing) and the standalone /edit route
// (kept alive for deep links, incl. Abel's). Saving calls the
// caller's onSaved with the updated record; each host decides
// what that means (close the sheet / return to the detail page).

import {useState, type FormEvent} from "react";
import {apiClient, ApiClientError} from "@/lib/api-client";
import type {Broker} from "@/types/entities";

export default function BrokerEditForm({ broker, onSaved }: { broker: Broker; onSaved: (broker: Broker) => void }) {
  const [name, setName] = useState(broker.name);
  const [mcNumber, setMcNumber] = useState(broker.mc_number ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<Broker>("brokers", broker.id, {
        name,
        mc_number: mcNumber || null,
      });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
        setFieldErrors(err.fields ?? []);
      } else {
        setError("Couldn't save. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="Edit this broker">
      <h2>Edit this broker</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="edit-name">Name</label>
        <input id="edit-name" value={name} onChange={(event) => setName(event.target.value)} required />

        <label htmlFor="edit-mc_number">MC number</label>
        <input
          id="edit-mc_number"
          value={mcNumber}
          onChange={(event) => setMcNumber(event.target.value)}
        />

        {error && <p role="alert">{error}</p>}
        {fieldErrors.length > 0 && (
          <ul role="alert">
            {fieldErrors.map((field) => (
              <li key={`${field.path}-${field.message}`}>
                {field.path}: {field.message}
              </li>
            ))}
          </ul>
        )}
        {saved && <p role="status">Saved.</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
      </form>
    </section>
  );
}
