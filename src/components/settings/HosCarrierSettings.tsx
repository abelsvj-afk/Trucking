"use client";

// Carrier HOS configuration editor (Reliability Unit B - design B.5,
// F-015), rendered inside More > Account & settings.
//
// These values are CARRIER-SPECIFIED: the cycle, the time of day the
// carrier's periods start (the anchor), whether the carrier allows
// the 34-hour restart, and the timezone the anchor is read in. The
// Hours screen's cycle math is computed from them. What ships by
// default - anchor 00:00, 70/8, restart on, America/New_York - is
// PROVISIONAL configuration chosen so the app works before the
// carrier's real rules are known; it is labeled as such here and must
// never be mistaken for verified carrier facts.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ListLoading, ListError } from "@/components/ListStates";
import { PROVISIONAL_HOS_CONFIG } from "@/lib/hos-periods";
import type { HosSettings } from "@/types/hos-settings";

const TIME_ZONE_OPTIONS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
];

type HosSettingsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; settings: HosSettings };

export default function HosCarrierSettings() {
  const [state, setState] = useState<HosSettingsState>({ status: "loading" });
  const [draft, setDraft] = useState<HosSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const fetchSettings = useCallback(() => {
    apiClient
      .getHosSettings()
      .then((settings) => {
        setState({ status: "loaded", settings });
        setDraft(settings);
      })
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again.";
        setState({ status: "error", message });
      });
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const isProvisional =
    draft !== null &&
    draft.hos_cycle === PROVISIONAL_HOS_CONFIG.cycle &&
    draft.hos_period_anchor === PROVISIONAL_HOS_CONFIG.periodAnchor &&
    draft.hos_restart_enabled === PROVISIONAL_HOS_CONFIG.restartEnabled &&
    draft.hos_carrier_timezone === PROVISIONAL_HOS_CONFIG.carrierTimeZone;

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const settings = await apiClient.updateHosSettings(draft);
      setState({ status: "loaded", settings });
      setDraft(settings);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiClientError && err.fields && err.fields.length > 0) {
        setSaveError(
          err.fields.map((f) => `${f.path}: ${f.message}`).join(" "),
        );
      } else {
        setSaveError(
          err instanceof ApiClientError ? err.message : "Couldn't save. Try again.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const timeZoneChoices =
    draft && !TIME_ZONE_OPTIONS.includes(draft.hos_carrier_timezone)
      ? [draft.hos_carrier_timezone, ...TIME_ZONE_OPTIONS]
      : TIME_ZONE_OPTIONS;

  return (
    <section aria-label="Carrier hours-of-service rules">
      <h2>Hours of service — carrier rules</h2>
      <p>
        <strong>Carrier-specified (set to match your carrier&apos;s HOS rules).</strong>{" "}
        Your weekly cycle on the Hours screen is computed from these: the cycle, the time
        of day your carrier&apos;s periods start, whether the 34-hour restart applies, and
        the timezone that start time is read in.
      </p>
      <p>
        The starting values are <strong>provisional defaults</strong> — period start 00:00,
        70/8 cycle, restart on, America/New_York — chosen so the app works before your
        carrier&apos;s actual rules are entered. They are not verified carrier facts.
      </p>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={fetchSettings} />}
      {state.status === "loaded" && draft && (
        <form onSubmit={handleSave}>
          {isProvisional && (
            <p role="status">These are still the provisional defaults.</p>
          )}
          <div>
            <label htmlFor="hos_cycle">Cycle</label>
            <select
              id="hos_cycle"
              value={draft.hos_cycle}
              onChange={(event) =>
                setDraft({ ...draft, hos_cycle: event.target.value as HosSettings["hos_cycle"] })
              }
            >
              <option value="70/8">70 hours / 8 days</option>
              <option value="60/7">60 hours / 7 days</option>
            </select>
          </div>
          <div>
            <label htmlFor="hos_period_anchor">Period start time (carrier time)</label>
            <input
              id="hos_period_anchor"
              type="time"
              value={draft.hos_period_anchor}
              onChange={(event) => setDraft({ ...draft, hos_period_anchor: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="hos_carrier_timezone">Carrier timezone</label>
            <select
              id="hos_carrier_timezone"
              value={draft.hos_carrier_timezone}
              onChange={(event) => setDraft({ ...draft, hos_carrier_timezone: event.target.value })}
            >
              {timeZoneChoices.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="hos_restart_enabled">
              <input
                id="hos_restart_enabled"
                type="checkbox"
                checked={draft.hos_restart_enabled}
                onChange={(event) => setDraft({ ...draft, hos_restart_enabled: event.target.checked })}
              />
              34-hour restart resets the cycle
            </label>
          </div>
          {saveError && <p role="alert">{saveError}</p>}
          {saved && <p role="status">Saved — the Hours screen now uses these rules.</p>}
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save carrier rules"}
          </button>
        </form>
      )}
    </section>
  );
}
