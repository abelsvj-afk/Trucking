"use client";

// "What this load pays me" on the load page (design: employer-pay-profile.md section 8). Shows the
// pay worked out from his terms (mile part + percent part), says which part made the number, and lets
// him set his OWN figure for this load (pay_override_cents) or clear it back to the terms. Gross, before
// fuel/taxes/deductions - his settlement is the final number.

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { projectLoad, formatRange } from "@/lib/pay-projection";
import { termsForDate, type PayTermsRow } from "@/lib/paycheck";
import type { EmployerPayProfile, Load } from "@/types/entities";
import { formatMoney } from "@/lib/money-format";

function centsFromDollars(text: string): number | null {
  const n = Number.parseFloat(text.replace(/[$,]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export default function LoadPaySection({ load, onSaved }: { load: Load; onSaved: (load: Load) => void }) {
  const [rows, setRows] = useState<PayTermsRow[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .list<EmployerPayProfile>("pay-profiles")
      .then((r) => {
        if (cancelled) return;
        setRows(
          r.data.map((p) => ({
            employer_name: p.employer_name,
            rate_cents_per_mile: p.rate_cents_per_mile,
            mile_basis: p.mile_basis,
            percent_of_load_bps: p.percent_of_load_bps ?? null,
            effective_from: p.effective_from,
            effective_to: p.effective_to,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(value: number | null) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await apiClient.update<Load>("loads", load.id, { pay_override_cents: value }));
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (rows === null) return null;
  const picked = termsForDate(rows, load.delivery_date ?? load.pickup_date);
  const projection = picked
    ? projectLoad(picked.terms, load)
    : load.pay_override_cents != null
      ? projectLoad({ employer_name: "", rate_cents_per_mile: 0, mile_basis: null }, load)
      : null;

  return (
    <section aria-label="What this load pays me">
      <h2>What this load pays me</h2>
      {!projection && (
        <p>
          No pay terms yet, so the app can&apos;t work this out. <Link href="/more/settings">Add them in Settings → Pay terms</Link>, or set the
          figure yourself below.
        </p>
      )}
      {projection && (
        <>
          <p role="status">
            {projection.lowCents === null || projection.highCents === null ? (
              <strong>Can&apos;t work it out yet</strong>
            ) : (
              <strong>{formatRange(projection.lowCents, projection.highCents)}</strong>
            )}
            {projection.overridden ? " · the figure you set" : picked ? ` · ${picked.terms.employer_name}` : ""}
          </p>
          <p className="row-sub">
            {projection.counted ? `Counted: ${projection.counted}. ` : ""}
            {projection.note}
          </p>
        </>
      )}
      {editing ? (
        <form
          aria-label="Set what this load pays me"
          onSubmit={(e) => {
            e.preventDefault();
            const cents = centsFromDollars(text);
            if (cents === null) return setError("Enter the amount in dollars, for example 1250.");
            void save(cents);
          }}
        >
          <label htmlFor="pay-override">What this load pays me (dollars)</label>
          <input id="pay-override" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy}>Save</button>{" "}
          <button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <p>
          <button
            type="button"
            onClick={() => {
              setText(load.pay_override_cents != null ? (load.pay_override_cents / 100).toFixed(2) : projection?.lowCents != null && projection.lowCents === projection.highCents ? (projection.lowCents / 100).toFixed(2) : "");
              setError(null);
              setEditing(true);
            }}
          >
            {load.pay_override_cents != null ? "Change my figure" : "Set my own figure for this load"}
          </button>{" "}
          {load.pay_override_cents != null && (
            <button type="button" disabled={busy} onClick={() => void save(null)}>
              Use my pay terms instead
            </button>
          )}
        </p>
      )}
      {error && !editing && <p role="alert">{error}</p>}
      <p className="row-sub">
        Gross, before fuel, taxes and deductions{load.pay_override_cents != null ? ` · you set ${formatMoney(load.pay_override_cents)}` : ""}. Your
        settlement is the final number.
      </p>
    </section>
  );
}
