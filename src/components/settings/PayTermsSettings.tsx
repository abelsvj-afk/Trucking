"use client";

// Employer pay terms (docs/design/employer-pay-profile.md), rendered inside
// More > Account & settings. Pay terms are the owner's DATA per employer -
// nothing here is hardcoded to any employer. Fields he has not set show as
// "Not set" and nothing computes from them; "Terms changed" starts a NEW
// dated row so earlier terms stay in the history.

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ListLoading, ListError } from "@/components/ListStates";
import { todayEastern } from "@/lib/eastern-date";
import type { EmployerPayProfile } from "@/types/entities";

const BASIS: Array<{ value: string; label: string }> = [
  { value: "", label: "Not set" },
  { value: "loaded", label: "Loaded miles only" },
  { value: "all", label: "All miles (loaded + deadhead)" },
  { value: "practical", label: "Practical miles (carrier-computed)" },
];
const WORKER: Array<{ value: string; label: string }> = [
  { value: "", label: "Not set" },
  { value: "w2", label: "W2 employee" },
  { value: "1099", label: "1099 contractor" },
];
const FUEL: Array<{ value: string; label: string }> = [
  { value: "", label: "Not set" },
  { value: "employer", label: "Employer pays fuel" },
  { value: "driver", label: "I pay fuel" },
];

const label = (opts: Array<{ value: string; label: string }>, v: string | null) =>
  opts.find((o) => o.value === (v ?? ""))?.label ?? "Not set";

const dollarsFromCents = (c: number) => (c / 100).toFixed(2);
function centsFromDollars(text: string): number | null {
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function ProfileEditor({ profile, onChanged }: { profile: EmployerPayProfile; onChanged: () => void }) {
  const [rate, setRate] = useState(dollarsFromCents(profile.rate_cents_per_mile));
  const [basis, setBasis] = useState(profile.mile_basis ?? "");
  const [worker, setWorker] = useState(profile.worker_type ?? "");
  const [fuel, setFuel] = useState(profile.fuel_paid_by ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const cents = centsFromDollars(rate);
  const body = () => ({
    rate_cents_per_mile: cents ?? 0,
    mile_basis: basis || null,
    worker_type: worker || null,
    fuel_paid_by: fuel || null,
  });

  async function run(fn: () => Promise<void>, done: string) {
    if (cents === null) {
      setError("Enter the rate as dollars per mile, for example 0.55.");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await fn();
      setSaved(done);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-label={`Pay terms for ${profile.employer_name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => void (await apiClient.update<EmployerPayProfile>("pay-profiles", profile.id, body())), "Saved (a correction to these terms).");
      }}
    >
      <h3>{profile.employer_name}</h3>
      <p className="row-sub">Terms since {profile.effective_from}.</p>
      <label htmlFor={`rate-${profile.id}`}>Pay per mile (dollars)</label>
      <input id={`rate-${profile.id}`} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
      <label htmlFor={`basis-${profile.id}`}>Which miles are paid</label>
      <select id={`basis-${profile.id}`} value={basis} onChange={(e) => setBasis(e.target.value)}>
        {BASIS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <label htmlFor={`worker-${profile.id}`}>Tax status</label>
      <select id={`worker-${profile.id}`} value={worker} onChange={(e) => setWorker(e.target.value)}>
        {WORKER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <label htmlFor={`fuel-${profile.id}`}>Fuel</label>
      <select id={`fuel-${profile.id}`} value={fuel} onChange={(e) => setFuel(e.target.value)}>
        {FUEL.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {(!basis || !worker) && (
        <p role="note" className="row-sub">
          {!basis ? "Miles basis is not set, " : ""}
          {!worker ? "tax status is not set, " : ""}
          so the app will not calculate pay from this rate yet. Nothing is guessed.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">{saved}</p>}
      <button type="submit" disabled={busy}>Save correction</button>{" "}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            // Close today's terms first: only one open-ended row per employer is allowed.
            const today = todayEastern();
            await apiClient.update<EmployerPayProfile>("pay-profiles", profile.id, { effective_to: today });
            await apiClient.create<EmployerPayProfile>("pay-profiles", { employer_name: profile.employer_name, effective_from: today, ...body() });
          }, "Started new terms; the earlier terms are kept in the history.")
        }
      >
        Terms changed — start new terms
      </button>
    </form>
  );
}

/** Starts the first (or an additional employer's) pay terms. Nothing is pre-filled: terms are entered by the owner. */
function AddTerms({ onAdded }: { onAdded: () => void }) {
  const [employer, setEmployer] = useState("");
  const [rate, setRate] = useState("");
  const [basis, setBasis] = useState("");
  const [worker, setWorker] = useState("");
  const [fuel, setFuel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      aria-label="Add pay terms"
      onSubmit={(e) => {
        e.preventDefault();
        const cents = centsFromDollars(rate);
        if (!employer.trim()) return setError("Enter the employer's name.");
        if (cents === null) return setError("Enter the rate as dollars per mile, for example 0.55.");
        setBusy(true);
        setError(null);
        apiClient
          .create<EmployerPayProfile>("pay-profiles", {
            employer_name: employer.trim(),
            rate_cents_per_mile: cents,
            mile_basis: basis || null,
            worker_type: worker || null,
            fuel_paid_by: fuel || null,
            effective_from: todayEastern(),
          })
          .then(() => {
            setEmployer("");
            setRate("");
            onAdded();
          })
          .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again."))
          .finally(() => setBusy(false));
      }}
    >
      <h3>Add pay terms</h3>
      <label htmlFor="add-employer">Employer</label>
      <input id="add-employer" value={employer} onChange={(e) => setEmployer(e.target.value)} />
      <label htmlFor="add-rate">Pay per mile (dollars)</label>
      <input id="add-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
      <label htmlFor="add-basis">Which miles are paid</label>
      <select id="add-basis" value={basis} onChange={(e) => setBasis(e.target.value)}>
        {BASIS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <label htmlFor="add-worker">Tax status</label>
      <select id="add-worker" value={worker} onChange={(e) => setWorker(e.target.value)}>
        {WORKER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <label htmlFor="add-fuel">Fuel</label>
      <select id="add-fuel" value={fuel} onChange={(e) => setFuel(e.target.value)}>
        {FUEL.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>Save pay terms</button>
    </form>
  );
}

export default function PayTermsSettings() {
  const [rows, setRows] = useState<EmployerPayProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiClient
      .list<EmployerPayProfile>("pay-profiles")
      .then((r) => {
        setRows(r.data);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "Couldn't load pay terms."));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ListError message={error} onRetry={load} />;
  if (!rows) return <ListLoading />;
  const current = rows.filter((r) => !r.effective_to);
  const history = rows.filter((r) => r.effective_to).sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return (
    <section aria-label="Pay terms">
      <h2>Pay terms</h2>
      <p>
        Your pay terms for each employer. They are your data — change them whenever the deal changes. Fields shown
        as &quot;Not set&quot; stay unset until you set them.
      </p>
      {current.length === 0 && <p>No pay terms entered yet. Add your current deal below — nothing is assumed.</p>}
      {current.map((p) => (
        <ProfileEditor key={`${p.id}-${p.updated_at}`} profile={p} onChanged={load} />
      ))}
      <AddTerms onAdded={load} />
      {history.length > 0 && (
        <details>
          <summary>Earlier terms</summary>
          <ul>
            {history.map((p) => (
              <li key={p.id}>
                {p.employer_name}: ${dollarsFromCents(p.rate_cents_per_mile)}/mi · {label(BASIS, p.mile_basis)} ·{" "}
                {label(WORKER, p.worker_type)} · {p.effective_from} to {p.effective_to}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
