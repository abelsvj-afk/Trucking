"use client";

// Credentials register (GAP-11; audit decision D-1, 2026-11-05: this feature
// had an API and Abel tools but no screen). Licence, medical card, annual
// inspection, registration, insurance - each with an expiry and a plain
// countdown (60/30/7-day ladder, days counted from today in Eastern time).
// "Renewed" updates the date. Abel's credential watch reads the same rows.

import { useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import { credentialLevel, daysUntil } from "@/lib/credentials";
import { todayEastern } from "@/lib/eastern-date";
import type { Credential } from "@/types/entities";

const KINDS: Array<{ value: Credential["kind"]; label: string }> = [
  { value: "cdl", label: "CDL" },
  { value: "medical_card", label: "Medical card" },
  { value: "annual_inspection", label: "Annual inspection" },
  { value: "registration_irp", label: "Registration / IRP" },
  { value: "insurance", label: "Insurance" },
  { value: "other", label: "Other" },
];

function countdown(days: number): string {
  if (days < 0) return `EXPIRED ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
  if (days === 0) return "expires today";
  return `${days} day${days === 1 ? "" : "s"} left`;
}

function CredentialRow({ credential, today, onChanged }: { credential: Credential; today: string; onChanged: () => void }) {
  const [renewed, setRenewed] = useState(credential.expires_on);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const days = daysUntil(today, credential.expires_on);
  const level = credentialLevel(days);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <span className="row-title">{credential.label}</span>
      <span className="row-sub">
        {KINDS.find((k) => k.value === credential.kind)?.label ?? credential.kind} · expires {credential.expires_on} ·{" "}
        <strong>{countdown(days)}</strong>
        {level === "ok" ? "" : level === "expired" ? " — this stops everything until it's renewed" : " — renew soon"}
      </span>
      {credential.notes && <span className="row-sub">{credential.notes}</span>}
      <div>
        <label htmlFor={`renew-${credential.id}`}>Renewed — new expiry date</label>
        <input id={`renew-${credential.id}`} type="date" value={renewed} onChange={(e) => setRenewed(e.target.value)} />{" "}
        <button
          type="button"
          disabled={busy || !renewed || renewed === credential.expires_on}
          onClick={() => void run(() => apiClient.update<Credential>("credentials", credential.id, { expires_on: renewed }))}
        >
          Save new date
        </button>{" "}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Remove ${credential.label} from the register?`)) void run(() => apiClient.remove("credentials", credential.id));
          }}
        >
          Remove
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

export default function CredentialsPage() {
  usePageTitle("Credentials");
  const { state, retry } = useApiList<Credential>("credentials");
  const [today] = useState(() => todayEastern());
  const [kind, setKind] = useState<Credential["kind"]>("cdl");
  const [label, setLabel] = useState("");
  const [expires, setExpires] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiClient.create<Credential>("credentials", { kind, label: label.trim(), expires_on: expires });
      setLabel("");
      setExpires("");
      retry();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const rows =
    state.status === "loaded"
      ? [...state.result.data].sort((a, b) => a.expires_on.localeCompare(b.expires_on))
      : [];

  return (
    <div>
      <PageHeader
        title="Credentials"
        purpose="Your licence, medical card, inspection, registration and insurance — with the days left on each, so nothing expires on you."
      />
      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && rows.length === 0 && (
        <TeachingEmpty title="No credentials yet" message="Add the things that can expire and stop you from working — start with your CDL and medical card." />
      )}
      {rows.length > 0 && (
        <ul>
          {rows.map((c) => (
            <CredentialRow key={`${c.id}-${c.updated_at}`} credential={c} today={today} onChanged={retry} />
          ))}
        </ul>
      )}

      <form aria-label="Add credential" onSubmit={handleAdd}>
        <h2>Add a credential</h2>
        <label htmlFor="cred-kind">Kind</label>
        <select id="cred-kind" value={kind} onChange={(e) => setKind(e.target.value as Credential["kind"])}>
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <label htmlFor="cred-label">Name</label>
        <input id="cred-label" value={label} onChange={(e) => setLabel(e.target.value)} required />
        <label htmlFor="cred-expires">Expires on</label>
        <input id="cred-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} required />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Add credential"}</button>
      </form>
    </div>
  );
}
