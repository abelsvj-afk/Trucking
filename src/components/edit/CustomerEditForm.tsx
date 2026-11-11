"use client";

// CustomerEditForm — extracted from the Customer detail page (UI/UX Phase 4,
// spec §2.4): ONE form component, two hosts — the detail page's
// Edit Sheet (in-place editing) and the standalone /edit route
// (kept alive for deep links, incl. Abel's). Saving calls the
// caller's onSaved with the updated record; each host decides
// what that means (close the sheet / return to the detail page).

import {useState, type FormEvent} from "react";
import {apiClient, ApiClientError} from "@/lib/api-client";
import type {Customer} from "@/types/entities";

export default function CustomerEditForm({
  customer,
  onSaved,
}: {
  customer: Customer;
  onSaved: (customer: Customer) => void;
}) {
  const [name, setName] = useState(customer.name);
  const [email, setEmail] = useState(customer.contact_email ?? "");
  const [phone, setPhone] = useState(customer.contact_phone ?? "");
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
      const updated = await apiClient.update<Customer>("customers", customer.id, {
        name,
        contact_email: email || null,
        contact_phone: phone || null,
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
    <section aria-label="Edit this customer">
      <h2>Edit this customer</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="edit-name">Name</label>
        <input id="edit-name" value={name} onChange={(event) => setName(event.target.value)} required />

        <label htmlFor="edit-email">Email</label>
        <input
          id="edit-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label htmlFor="edit-phone">Phone</label>
        <input id="edit-phone" value={phone} onChange={(event) => setPhone(event.target.value)} />

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
