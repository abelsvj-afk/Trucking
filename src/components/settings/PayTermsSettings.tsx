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

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Not set" },
  ...WEEKDAYS.map((name, i) => ({ value: String(i), label: name })),
];

const dollarsFromCents = (c: number) => (c / 100).toFixed(2);
/** "" = no value (0 cents); invalid text = null. */
function centsFromDollars(text: string): number | null {
  if (text.trim() === "") return 0;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
/** "85" or "85.5" percent -> basis points; "" = none (null); invalid or over 100 = undefined. */
function bpsFromPercent(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : undefined;
}
const percentFromBps = (bps: number | null | undefined) => (bps == null ? "" : String(Number((bps / 100).toFixed(2))));

interface PayFieldValues {
  rate: string;
  percent: string;
  basis: string;
  worker: string;
  fuel: string;
  weekEnd: string;
  payday: string;
}
const EMPTY_FIELDS: PayFieldValues = { rate: "", percent: "", basis: "", worker: "", fuel: "", weekEnd: "", payday: "" };
const fieldsOf = (p: EmployerPayProfile): PayFieldValues => ({
  rate: p.rate_cents_per_mile > 0 ? dollarsFromCents(p.rate_cents_per_mile) : "",
  percent: percentFromBps(p.percent_of_load_bps),
  basis: p.mile_basis ?? "",
  worker: p.worker_type ?? "",
  fuel: p.fuel_paid_by ?? "",
  weekEnd: p.pay_week_ends_on == null ? "" : String(p.pay_week_ends_on),
  payday: p.payday_weekday == null ? "" : String(p.payday_weekday),
});

/** The request body for the fields, or the plain-words problem with them. */
function bodyOf(f: PayFieldValues): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const cents = centsFromDollars(f.rate);
  if (cents === null) return { ok: false, error: "Enter the per-mile pay as dollars, for example 0.55 - or leave it empty if you are paid a percent." };
  const bps = bpsFromPercent(f.percent);
  if (bps === undefined) return { ok: false, error: "Enter the percent of the load as a number from 0 to 100, for example 85." };
  return {
    ok: true,
    body: {
      rate_cents_per_mile: cents,
      percent_of_load_bps: bps,
      mile_basis: f.basis || null,
      worker_type: f.worker || null,
      fuel_paid_by: f.fuel || null,
      pay_week_ends_on: f.weekEnd === "" ? null : Number(f.weekEnd),
      payday_weekday: f.payday === "" ? null : Number(f.payday),
    },
  };
}

function Select({ id, label: text, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <>
      <label htmlFor={id}>{text}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </>
  );
}

/** The editable pay fields, shared by "add" and "edit": cents per mile and/or percent of the load, pay week, payday. */
function PayFields({ idp, value, onChange }: { idp: string; value: PayFieldValues; onChange: (v: PayFieldValues) => void }) {
  const set = (patch: Partial<PayFieldValues>) => onChange({ ...value, ...patch });
  const mileOnly = Number.parseFloat(value.rate) > 0;
  return (
    <>
      <label htmlFor={`${idp}-rate`}>Pay per mile (dollars) - leave empty if you are paid a percent only</label>
      <input id={`${idp}-rate`} inputMode="decimal" value={value.rate} onChange={(e) => set({ rate: e.target.value })} />
      <label htmlFor={`${idp}-percent`}>Percent of the load (for example 85) - leave empty if you are paid by the mile only</label>
      <input id={`${idp}-percent`} inputMode="decimal" value={value.percent} onChange={(e) => set({ percent: e.target.value })} />
      <p className="row-sub">Both can be set - then your pay is the mile part plus the percent part.</p>
      {(mileOnly || value.basis !== "") && <Select id={`${idp}-basis`} label="Which miles are paid" value={value.basis} onChange={(v) => set({ basis: v })} options={BASIS} />}
      {!mileOnly && value.basis === "" && <p className="row-sub">(The miles basis only matters once a per-mile rate is entered.)</p>}
      <Select id={`${idp}-worker`} label="Tax status" value={value.worker} onChange={(v) => set({ worker: v })} options={WORKER} />
      <Select id={`${idp}-fuel`} label="Fuel" value={value.fuel} onChange={(v) => set({ fuel: v })} options={FUEL} />
      <Select id={`${idp}-weekend`} label="Your pay week ends on" value={value.weekEnd} onChange={(v) => set({ weekEnd: v })} options={DAY_OPTIONS} />
      <Select id={`${idp}-payday`} label="You get paid on" value={value.payday} onChange={(v) => set({ payday: v })} options={DAY_OPTIONS} />
      {(value.weekEnd === "" || value.payday === "") && (
        <p className="row-sub" role="note">
          {value.weekEnd === "" ? "Pay week not set - weeks run Monday to Sunday for now. " : ""}
          {value.payday === "" ? "Payday not set - weekly totals show without a payday date." : ""}
        </p>
      )}
    </>
  );
}

function ProfileEditor({ profile, onChanged }: { profile: EmployerPayProfile; onChanged: () => void }) {
  const [fields, setFields] = useState<PayFieldValues>(fieldsOf(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function run(fn: (body: Record<string, unknown>) => Promise<void>, done: string) {
    const checked = bodyOf(fields);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await fn(checked.body);
      setSaved(done);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const mileSet = Number.parseFloat(fields.rate) > 0;
  const noAmount = !mileSet && !(Number.parseFloat(fields.percent) > 0);
  return (
    <form
      aria-label={`Pay terms for ${profile.employer_name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void run(async (body) => void (await apiClient.update<EmployerPayProfile>("pay-profiles", profile.id, body)), "Saved (a correction to these terms).");
      }}
    >
      <h3>{profile.employer_name}</h3>
      <p className="row-sub">Terms since {profile.effective_from}.</p>
      <PayFields idp={`edit-${profile.id}`} value={fields} onChange={setFields} />
      {noAmount && <p role="note" className="row-sub">No per-mile rate or percent entered, so the app has nothing to calculate pay from yet.</p>}
      {mileSet && (!fields.basis || !fields.worker) && (
        <p role="note" className="row-sub">
          {!fields.basis ? "Miles basis is not set - pay by the mile shows as a range until it is. " : ""}
          {!fields.worker ? "Tax status is not set. " : ""}Nothing is guessed.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">{saved}</p>}
      <button type="submit" disabled={busy}>Save correction</button>{" "}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async (body) => {
            // Close today's terms first: only one open-ended row per employer is allowed.
            const today = todayEastern();
            await apiClient.update<EmployerPayProfile>("pay-profiles", profile.id, { effective_to: today });
            await apiClient.create<EmployerPayProfile>("pay-profiles", { employer_name: profile.employer_name, effective_from: today, ...body });
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
  const [fields, setFields] = useState<PayFieldValues>(EMPTY_FIELDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      aria-label="Add pay terms"
      onSubmit={(e) => {
        e.preventDefault();
        const checked = bodyOf(fields);
        if (!employer.trim()) return setError("Enter the employer's name.");
        if (!checked.ok) return setError(checked.error);
        if (checked.body.rate_cents_per_mile === 0 && checked.body.percent_of_load_bps == null) {
          return setError("Enter a per-mile rate, a percent of the load, or both.");
        }
        setBusy(true);
        setError(null);
        apiClient
          .create<EmployerPayProfile>("pay-profiles", { employer_name: employer.trim(), effective_from: todayEastern(), ...checked.body })
          .then(() => {
            setEmployer("");
            setFields(EMPTY_FIELDS);
            onAdded();
          })
          .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again."))
          .finally(() => setBusy(false));
      }}
    >
      <h3>Add pay terms</h3>
      <label htmlFor="add-employer">Employer</label>
      <input id="add-employer" value={employer} onChange={(e) => setEmployer(e.target.value)} />
      <PayFields idp="add" value={fields} onChange={setFields} />
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
                {p.employer_name}: {p.rate_cents_per_mile > 0 ? `$${dollarsFromCents(p.rate_cents_per_mile)}/mi` : ""}
                {p.rate_cents_per_mile > 0 && p.percent_of_load_bps ? " + " : ""}
                {p.percent_of_load_bps ? `${percentFromBps(p.percent_of_load_bps)} of the load` : ""} · {label(BASIS, p.mile_basis)} ·{" "}
                {label(WORKER, p.worker_type)} · {p.effective_from} to {p.effective_to}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
