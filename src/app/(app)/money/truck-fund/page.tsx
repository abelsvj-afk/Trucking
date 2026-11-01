"use client";

// Truck Fund + money visibility (docs/design/driver-mvp.md §9).
// One page, plain sections: the Truck Fund and its progress toward a
// used-truck band, the suggestion card (when a sweep rule exists and
// money settled), earned-toward-the-fund periods, his other two
// buckets, the fund log with its add-entry form, then the ladder and
// account-snapshot sections (ladder.tsx / snapshots.tsx).
//
// The honesty lines are part of the feature, not decoration: earned
// is never called a balance, and every surface that touches the
// suggestion says the app never moves real money.

import { useState, type FormEvent } from "react";
import { useTruckFund } from "@/lib/use-truck-fund";
import { ListLoading, ListError, ListEmpty } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import { apiClient, ApiClientError } from "@/lib/api-client";
import {
  EMERGENCY_FUND_TARGET_CENTS,
  TRUCK_PRICE_BANDS,
  formatDollars,
  type FundKey,
  type SweepMode,
  type TruckPriceBandKey,
} from "@/lib/truck-fund";
import type { FundEntry } from "@/types/entities";
import LadderSection from "./ladder";
import SnapshotsSection from "./snapshots";

const BAND_OPTIONS: { value: TruckPriceBandKey; label: string }[] = (
  Object.entries(TRUCK_PRICE_BANDS) as [TruckPriceBandKey, (typeof TRUCK_PRICE_BANDS)[TruckPriceBandKey]][]
).map(([key, band]) => ({
  value: key,
  label: `${band.label} — ${formatDollars(band.lowCents)} to ${formatDollars(band.highCents)}`,
}));

export default function TruckFundPage() {
  usePageTitle("Truck Fund");
  const { state, retry } = useTruckFund();
  const data = state.status === "loaded" ? state.overview : null;

  const [actionError, setActionError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  // Add-entry form state.
  const [entryFund, setEntryFund] = useState<FundKey>("truck_fund");
  const [entryKind, setEntryKind] = useState<"deposit" | "withdrawal">("deposit");
  const [entryAmount, setEntryAmount] = useState("");
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [entryLane, setEntryLane] = useState<"business" | "personal">("business");
  const [entryNote, setEntryNote] = useState("");
  const [savingEntry, setSavingEntry] = useState(false);

  // Settings form state (seeded from the aggregate once it loads).
  const [settingsSeeded, setSettingsSeeded] = useState(false);
  const [sweepMode, setSweepMode] = useState<SweepMode>("off");
  const [sweepPercent, setSweepPercent] = useState("");
  const [sweepFlat, setSweepFlat] = useState("");
  const [targetBand, setTargetBand] = useState("");
  const [targetCustom, setTargetCustom] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

  if (data && !settingsSeeded) {
    setSettingsSeeded(true);
    setSweepMode(data.settings.sweep_mode);
    setSweepPercent(data.settings.sweep_percent?.toString() ?? "");
    setSweepFlat(
      data.settings.sweep_flat_cents != null ? (data.settings.sweep_flat_cents / 100).toString() : "",
    );
    setTargetBand(data.settings.target_band ?? "");
    setTargetCustom(
      data.settings.target_cents != null ? (data.settings.target_cents / 100).toString() : "",
    );
  }

  async function recordSuggestion() {
    if (!data?.suggestion) return;
    setActionError(null);
    setRecording(true);
    try {
      await apiClient.create<FundEntry>("fund-entries", {
        fund_key: "truck_fund",
        kind: "deposit",
        amount_cents: data.suggestion.amount_cents,
        entry_date: new Date().toISOString().slice(0, 10),
        lane: "business",
        source: "sweep",
        note: "Sweep rule suggestion, recorded by owner",
      });
      retry();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Couldn't record it. Try again.");
    } finally {
      setRecording(false);
    }
  }

  async function saveEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setSavingEntry(true);
    try {
      await apiClient.create<FundEntry>("fund-entries", {
        fund_key: entryFund,
        kind: entryKind,
        amount_cents: Math.round(parseFloat(entryAmount || "0") * 100),
        entry_date: entryDate,
        lane: entryLane,
        source: "manual",
        note: entryNote || null,
      });
      setEntryAmount("");
      setEntryNote("");
      retry();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Couldn't save the entry. Try again.");
    } finally {
      setSavingEntry(false);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setSavingSettings(true);
    try {
      await apiClient.updateFundSettings({
        sweep_mode: sweepMode,
        sweep_percent: sweepMode === "percent" ? parseInt(sweepPercent || "0", 10) : null,
        sweep_flat_cents:
          sweepMode === "flat" ? Math.round(parseFloat(sweepFlat || "0") * 100) : null,
        target_band: targetBand === "" ? null : targetBand,
        target_cents: targetCustom ? Math.round(parseFloat(targetCustom) * 100) : null,
      });
      retry();
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : "Couldn't save settings. Try again.",
      );
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <div>
      <h1>Truck Fund</h1>
      <p>
        Saving toward your own truck. This page tracks the money you log and the money the business
        earns — it never moves real money. Moving it is always your hand, in your bank app.
      </p>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {actionError && (
        <div role="alert">
          <p>{actionError}</p>
        </div>
      )}

      {data && (
        <>
          <section aria-labelledby="fund-heading">
            <h2 id="fund-heading">Truck Fund</h2>
            <p>
              <strong>{formatDollars(data.truck_fund_progress.balance_cents)}</strong> logged
              {data.truck_fund_progress.target_cents != null && (
                <>
                  {" "}
                  of {formatDollars(data.truck_fund_progress.target_cents)} target
                  {data.truck_fund_progress.percent_of_target != null &&
                    ` — ${data.truck_fund_progress.percent_of_target}% there, ${formatDollars(data.truck_fund_progress.remaining_cents ?? 0)} to go`}
                </>
              )}
            </p>
            {data.truck_fund_progress.target_cents != null &&
              data.truck_fund_progress.percent_of_target != null && (
                <progress
                  max={100}
                  value={Math.min(100, data.truck_fund_progress.percent_of_target)}
                  aria-label="Progress toward the Truck Fund target"
                />
              )}
            {data.truck_fund_progress.position === "below_band" && (
              <p>Still below the band — every logged dollar counts.</p>
            )}
            {data.truck_fund_progress.position === "in_band" && (
              <p>You&apos;re inside the band. Trucks in this range exist — condition decides.</p>
            )}
            {data.truck_fund_progress.position === "past_band" && (
              <p>Past the top of the band — you have room to be picky, or aim higher.</p>
            )}
            {data.truck_fund_progress.target_cents == null && (
              <p>
                No target picked yet — choose a band or your own number in Settings below. The
                bands are estimates from used-truck market guides, and the real number is truck
                price plus a repair reserve plus startup costs (filings, insurance down payment,
                plates) — set your target with that in mind.
              </p>
            )}
            {data.truck_fund_progress.target_cents != null && (
              <p>
                Bands are estimates — the real target is truck price plus a repair reserve plus
                startup costs. Verify against live listings when you&apos;re actually shopping.
              </p>
            )}
          </section>

          {data.suggestion && (
            <section aria-labelledby="suggestion-heading">
              <h2 id="suggestion-heading">Suggestion</h2>
              <p>{data.suggestion.text}</p>
              <button type="button" onClick={recordSuggestion} disabled={recording}>
                {recording ? "Recording…" : "Record it"}
              </button>
              <p>
                Recording only writes it in this log — the app never moves real money. Make the
                actual transfer in your bank app.
              </p>
            </section>
          )}

          <section aria-labelledby="earned-heading">
            <h2 id="earned-heading">Earned toward the fund</h2>
            <p>
              What completed loads settled, minus the costs logged against them. This is earned,
              not saved — it only becomes fund money when you log moving it below.
            </p>
            <dl>
              <dt>This week ({data.periods.week.from} – {data.periods.week.to})</dt>
              <dd>
                Settled {formatDollars(data.periods.week.settled_income_cents)} — costs{" "}
                {formatDollars(data.periods.week.costs_cents)} — net{" "}
                {formatDollars(data.periods.week.settled_net_cents)}
              </dd>
              <dt>This month ({data.periods.month.from} – {data.periods.month.to})</dt>
              <dd>
                Settled {formatDollars(data.periods.month.settled_income_cents)} — costs{" "}
                {formatDollars(data.periods.month.costs_cents)} — net{" "}
                {formatDollars(data.periods.month.settled_net_cents)}
              </dd>
            </dl>
          </section>

          <section aria-labelledby="buckets-heading">
            <h2 id="buckets-heading">Your other buckets</h2>
            <dl>
              <dt>Business-credit bucket</dt>
              <dd>
                {formatDollars(data.funds.business_credit.balance_cents)}
                {data.funds.business_credit.last_entry_date &&
                  ` — last entry ${data.funds.business_credit.last_entry_date}`}
              </dd>
              <dt>Emergency fund</dt>
              <dd>
                {formatDollars(data.funds.emergency_fund.balance_cents)} of{" "}
                {formatDollars(EMERGENCY_FUND_TARGET_CENTS)} — your Finance Project&apos;s target,
                shown here for context; that plan runs the emergency fund, this page just shows
                it.
                {data.funds.emergency_fund.last_entry_date &&
                  ` Last entry ${data.funds.emergency_fund.last_entry_date}.`}
              </dd>
            </dl>
          </section>

          <section aria-labelledby="log-heading">
            <h2 id="log-heading">Fund log</h2>
            {data.entries.length === 0 ? (
              <ListEmpty message="Nothing logged yet — when you move money by hand, write it here so the fund always tells the truth." />
            ) : (
              <ul>
                {data.entries.map((entry) => (
                  <li key={entry.id}>
                    {entry.entry_date} — {entry.fund_key === "truck_fund" ? "Truck Fund" : entry.fund_key === "business_credit" ? "Business-credit bucket" : "Emergency fund"} —{" "}
                    {entry.kind === "deposit" ? "+" : "−"}
                    {formatDollars(entry.amount_cents)} ({entry.lane}
                    {entry.source === "sweep" ? ", sweep rule" : ""}){entry.note && ` — ${entry.note}`}
                  </li>
                ))}
              </ul>
            )}

            <h3>Log a move</h3>
            <form onSubmit={saveEntry}>
              <label htmlFor="entry-fund">Fund</label>
              <select
                id="entry-fund"
                value={entryFund}
                onChange={(e) => setEntryFund(e.target.value as FundKey)}
              >
                <option value="truck_fund">Truck Fund</option>
                <option value="business_credit">Business-credit bucket</option>
                <option value="emergency_fund">Emergency fund</option>
              </select>

              <label htmlFor="entry-kind">Type</label>
              <select
                id="entry-kind"
                value={entryKind}
                onChange={(e) => setEntryKind(e.target.value as "deposit" | "withdrawal")}
              >
                <option value="deposit">Money in</option>
                <option value="withdrawal">Money out</option>
              </select>

              <label htmlFor="entry-amount">Amount ($)</label>
              <input
                id="entry-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={entryAmount}
                onChange={(e) => setEntryAmount(e.target.value)}
                required
              />

              <label htmlFor="entry-date">Date</label>
              <input
                id="entry-date"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                required
              />

              <label htmlFor="entry-lane">Whose money</label>
              <select
                id="entry-lane"
                value={entryLane}
                onChange={(e) => setEntryLane(e.target.value as "business" | "personal")}
              >
                <option value="business">Business</option>
                <option value="personal">Personal</option>
              </select>

              <label htmlFor="entry-note">Note</label>
              <input
                id="entry-note"
                type="text"
                value={entryNote}
                onChange={(e) => setEntryNote(e.target.value)}
              />

              <button type="submit" disabled={savingEntry}>
                {savingEntry ? "Saving…" : "Log it"}
              </button>
            </form>
          </section>

          <section aria-labelledby="settings-heading">
            <h2 id="settings-heading">Settings</h2>
            <form onSubmit={saveSettings}>
              <label htmlFor="sweep-mode">Sweep rule</label>
              <select
                id="sweep-mode"
                value={sweepMode}
                onChange={(e) => setSweepMode(e.target.value as SweepMode)}
              >
                <option value="off">Off — never suggest</option>
                <option value="percent">Send a percent of each week&apos;s settled net</option>
                <option value="flat">Send a flat amount each week money settles</option>
              </select>
              <p>
                With the rule off, this page never suggests anything. With it on, it suggests after
                a week settles in the black — you still record it and move the money yourself.
              </p>

              {sweepMode === "percent" && (
                <>
                  <label htmlFor="sweep-percent">Percent of settled net (%)</label>
                  <input
                    id="sweep-percent"
                    type="number"
                    min="1"
                    max="100"
                    value={sweepPercent}
                    onChange={(e) => setSweepPercent(e.target.value)}
                    required
                  />
                </>
              )}
              {sweepMode === "flat" && (
                <>
                  <label htmlFor="sweep-flat">Flat amount ($)</label>
                  <input
                    id="sweep-flat"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={sweepFlat}
                    onChange={(e) => setSweepFlat(e.target.value)}
                    required
                  />
                </>
              )}

              <label htmlFor="target-band">Truck price band (estimates)</label>
              <select
                id="target-band"
                value={targetBand}
                onChange={(e) => setTargetBand(e.target.value)}
              >
                <option value="">No band</option>
                {BAND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              <label htmlFor="target-custom">Your own target ($) — overrides the band</label>
              <input
                id="target-custom"
                type="number"
                step="0.01"
                min="0"
                value={targetCustom}
                onChange={(e) => setTargetCustom(e.target.value)}
              />

              <button type="submit" disabled={savingSettings}>
                {savingSettings ? "Saving…" : "Save settings"}
              </button>
            </form>
          </section>

          <LadderSection steps={data.ladder} onChanged={retry} />
          <SnapshotsSection accounts={data.accounts} onChanged={retry} />
        </>
      )}
    </div>
  );
}
