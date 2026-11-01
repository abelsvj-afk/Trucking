"use client";

// Accounts section (docs/design/driver-mvp.md §9.5) - the manual
// snapshots behind the account-visibility seam. The honesty copy is
// load-bearing: these are balances recorded by hand, true as of
// their date, with the age of that truth labeled. Nothing here is a
// live bank connection, and the section says so.

import { useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { formatDollars } from "@/lib/truck-fund";
import type { AccountSnapshot } from "@/types/entities";
import type { AccountView } from "@/types/truck-fund";

export default function SnapshotsSection({
  accounts,
  onChanged,
}: {
  accounts: AccountView[];
  onChanged: () => void | Promise<void>;
}) {
  const [institution, setInstitution] = useState("");
  const [accountName, setAccountName] = useState("");
  const [last4, setLast4] = useState("");
  const [balance, setBalance] = useState("");
  const [lane, setLane] = useState<"business" | "personal">("business");
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await apiClient.create<AccountSnapshot>("account-snapshots", {
        institution,
        account_name: accountName,
        last4,
        balance_cents: Math.round(parseFloat(balance || "0") * 100),
        lane,
        as_of_date: asOf,
        note: note || null,
      });
      setInstitution("");
      setAccountName("");
      setLast4("");
      setBalance("");
      setNote("");
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save the snapshot. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(account: AccountView) {
    setError(null);
    try {
      await apiClient.remove("account-snapshots", account.id);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't remove it. Try again.");
    }
  }

  return (
    <section aria-labelledby="accounts-heading">
      <h2 id="accounts-heading">Accounts</h2>
      <p>
        Balances you record by hand — true as of the date on each one, never a live bank sync. When
        a balance changes, add a fresh snapshot; the old one stays in the record. A live read-only
        bank connection is a later build — it needs your own Plaid developer account wired to this
        app first.
      </p>
      {error && (
        <div role="alert">
          <p>{error}</p>
        </div>
      )}
      {accounts.length === 0 ? (
        <p>No snapshots yet — record one below so the fund picture includes what&apos;s actually in the bank.</p>
      ) : (
        <ul>
          {accounts.map((account) => (
            <li key={account.id}>
              {account.institution} — {account.account_name} (••{account.last4}) —{" "}
              {formatDollars(account.balance_cents)} ({account.lane}) — as of {account.as_of_date},{" "}
              {account.staleness.label.toLowerCase()}
              {account.staleness.level !== "current" && ` (${account.staleness.age_days} days old)`}
              {account.note && ` — ${account.note}`}{" "}
              <button type="button" onClick={() => remove(account)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Record a balance</h3>
      <form onSubmit={save}>
        <label htmlFor="snap-institution">Bank / institution</label>
        <input
          id="snap-institution"
          type="text"
          value={institution}
          onChange={(e) => setInstitution(e.target.value)}
          required
        />

        <label htmlFor="snap-name">Account name</label>
        <input
          id="snap-name"
          type="text"
          value={accountName}
          onChange={(e) => setAccountName(e.target.value)}
          required
        />

        <label htmlFor="snap-last4">Last 4 digits only</label>
        <input
          id="snap-last4"
          type="text"
          inputMode="numeric"
          maxLength={4}
          value={last4}
          onChange={(e) => setLast4(e.target.value)}
          required
        />

        <label htmlFor="snap-balance">Balance ($) — negative if it&apos;s money owed</label>
        <input
          id="snap-balance"
          type="number"
          step="0.01"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          required
        />

        <label htmlFor="snap-lane">Whose account</label>
        <select
          id="snap-lane"
          value={lane}
          onChange={(e) => setLane(e.target.value as "business" | "personal")}
        >
          <option value="business">Business</option>
          <option value="personal">Personal</option>
        </select>

        <label htmlFor="snap-date">Balance as of</label>
        <input
          id="snap-date"
          type="date"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          required
        />

        <label htmlFor="snap-note">Note</label>
        <input id="snap-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} />

        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Record snapshot"}
        </button>
      </form>
    </section>
  );
}
