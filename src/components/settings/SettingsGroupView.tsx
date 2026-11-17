"use client";

// One settings group on its own page (docs/design/settings-index.md, owner-approved 2026-11-12). The markup and the
// behaviour of every block below are the ones the single long Settings page had; only which block renders is new.
// AI kill switches stay per docs/governance.md: visible, effective for the next run, never interrupting one in progress.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { createClient } from "@/services/db/client";
import { ListLoading, ListError } from "@/components/ListStates";
import Card from "@/components/Card";
import HosCarrierSettings from "@/components/settings/HosCarrierSettings";
import BackgroundTrackingSettings from "@/components/settings/BackgroundTrackingSettings";
import TelegramConnectionSettings from "@/components/settings/TelegramConnectionSettings";
import EmailInboxSettings from "@/components/settings/EmailInboxSettings";
import PayTermsSettings from "@/components/settings/PayTermsSettings";
import { useToast } from "@/components/Toast";
import {
  applyThemeChoice,
  resolveThemeChoice,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "@/lib/theme";
import {
  resolveShowBusinessSummary,
  storeShowBusinessSummary,
  HOME_BUSINESS_SUMMARY_STORAGE_KEY,
} from "@/lib/home-display";
import type { AiSettings } from "@/types/ai-settings";
import { splitLabel, type SettingsGroupSlug } from "@/lib/settings-groups";
import { CAPABILITY_LABELS } from "@/lib/ai-capability-labels";

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
];

type SettingsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; settings: AiSettings };

export default function SettingsGroupView({ group }: { group: SettingsGroupSlug }) {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<SettingsState>({ status: "loading" });
  const [signingOut, setSigningOut] = useState(false);
  // Toggle failures used to roll back silently (audit Section B/F-3):
  // the switch flipped back and said nothing. Now the failure speaks -
  // an inline message here plus a toast.
  const [toggleError, setToggleError] = useState<string | null>(null);
  // Voice on calls (docs/design/outbound-calling.md): the options come
  // from /api/v1/call-voices; null means the list didn't load, and the
  // dropdown then offers only the Telnyx default.
  const [callVoices, setCallVoices] = useState<{
    configured: boolean;
    voices: { id: string | null; label: string; provider: string; cost_note: string }[];
  } | null>(null);
  // Theme choice (parked decision (d), src/lib/theme.ts): read from
  // localStorage via useSyncExternalStore (server snapshot = the
  // shipped default, so hydration agrees); a pick in this session
  // overrides the stored value immediately.
  const storedTheme = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("storage", onChange);
      return () => window.removeEventListener("storage", onChange);
    },
    () => window.localStorage.getItem(THEME_STORAGE_KEY),
    () => null,
  );
  const [pickedTheme, setPickedTheme] = useState<ThemeChoice | null>(null);
  const themeChoice = pickedTheme ?? resolveThemeChoice(storedTheme);

  function pickTheme(choice: ThemeChoice) {
    setPickedTheme(choice);
    applyThemeChoice(choice);
  }

  // Home "This month" business summary visibility (owner order
  // 2026-11-07, src/lib/home-display.ts): same device-local pattern
  // as the theme pick - hidden by default, the stored value read via
  // useSyncExternalStore, a pick in this session overriding at once.
  const storedBusinessSummary = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("storage", onChange);
      return () => window.removeEventListener("storage", onChange);
    },
    () => window.localStorage.getItem(HOME_BUSINESS_SUMMARY_STORAGE_KEY),
    () => null,
  );
  const [pickedBusinessSummary, setPickedBusinessSummary] = useState<boolean | null>(null);
  const showBusinessSummary = pickedBusinessSummary ?? resolveShowBusinessSummary(storedBusinessSummary);

  function pickBusinessSummary(show: boolean) {
    setPickedBusinessSummary(show);
    storeShowBusinessSummary(show);
  }

  const fetchSettings = useCallback(() => {
    apiClient
      .getAiSettings()
      .then((settings) => setState({ status: "loaded", settings }))
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again.";
        setState({ status: "error", message });
      });
  }, []);

  useEffect(() => {
    if (group === "ai") fetchSettings();
  }, [fetchSettings, group]);

  useEffect(() => {
    if (group !== "ai") return;
    apiClient
      .getCallVoices()
      .then((result) => setCallVoices({ configured: result.configured, voices: result.voices }))
      .catch(() => setCallVoices(null));
  }, [group]);

  async function toggleGlobal(nextValue: boolean) {
    if (state.status !== "loaded") return;
    const previous = state.settings;
    setToggleError(null);
    setState({ status: "loaded", settings: { ...previous, globally_disabled: nextValue } });
    try {
      const settings = await apiClient.updateAiSettings({ globally_disabled: nextValue });
      setState({ status: "loaded", settings });
    } catch {
      setState({ status: "loaded", settings: previous });
      const message = "Couldn't save that change — the switch has been put back. Try again.";
      setToggleError(message);
      toast.error(message);
    }
  }

  async function toggleCapability(capability: string, nextValue: boolean) {
    if (state.status !== "loaded") return;
    const previous = state.settings;
    setToggleError(null);
    setState({
      status: "loaded",
      settings: { ...previous, capabilities: { ...previous.capabilities, [capability]: nextValue } },
    });
    try {
      const settings = await apiClient.updateAiSettings({ capabilities: { [capability]: nextValue } });
      setState({ status: "loaded", settings });
    } catch {
      setState({ status: "loaded", settings: previous });
      const message = "Couldn't save that change — the switch has been put back. Try again.";
      setToggleError(message);
      toast.error(message);
    }
  }

  async function pickCallVoice(nextValue: string | null) {
    if (state.status !== "loaded") return;
    const previous = state.settings;
    setToggleError(null);
    setState({ status: "loaded", settings: { ...previous, call_voice_id: nextValue } });
    try {
      const settings = await apiClient.updateAiSettings({ call_voice_id: nextValue });
      setState({ status: "loaded", settings });
    } catch {
      setState({ status: "loaded", settings: previous });
      const message = "Couldn't save that voice — the pick has been put back. Try again.";
      setToggleError(message);
      toast.error(message);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div>
      {group === "pay" && (
        <>
      <Card className="settings-card">
        <h2 id="settings-pay" className="settings-group">My pay</h2>
        <PayTermsSettings />
      </Card>
        </>
      )}
      {group === "hours" && (
        <>
      <Card className="settings-card">
        <h2 id="settings-hours" className="settings-group">My hours and truck</h2>
        <HosCarrierSettings />

        <BackgroundTrackingSettings />
      </Card>
        </>
      )}
      {group === "connections" && (
        <>
      <Card className="settings-card">
        <h2 id="settings-connections" className="settings-group">Connections</h2>
        <TelegramConnectionSettings />

        <EmailInboxSettings />
      </Card>
        </>
      )}
      {group === "look" && (
        <>
      <h2 id="settings-look" className="settings-group">Appearance and Home</h2>
      <section aria-label="Appearance" className="ds-card">
        <h2>Appearance</h2>
        <p>
          Light, dark, or Auto — Auto follows your phone&apos;s own setting, like it does today.
          Your pick is saved on this device.
        </p>
        <div role="group" aria-label="Theme">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={themeChoice === option.value}
              onClick={() => pickTheme(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Home screen" className="ds-card">
        <h2>Home screen</h2>
        <p>
          The &ldquo;This month&rdquo; block on Home is your future company view — revenue, expenses
          and operating result for money running through your own company. While your income is
          driver pay, it just reads as zeros, so it stays hidden unless you switch it on here.
          Your pick is saved on this device.
        </p>
        <label htmlFor="home_business_summary">
          <input
            id="home_business_summary"
            type="checkbox"
            checked={showBusinessSummary}
            onChange={(event) => pickBusinessSummary(event.target.checked)}
          />
          Show the &ldquo;This month&rdquo; business summary on Home
        </label>
      </section>
        </>
      )}
      {group === "ai" && (
        <>
      <h2 id="settings-ai" className="settings-group">Abel and AI</h2>
      <section aria-label="AI authorization" data-motion-exempt className="ds-card">
        <h2>AI authorization</h2>
        <p>
          These control what the AI is allowed to run automatically. Turning a switch off takes
          effect before the next scheduled run — it never interrupts one already in progress.
        </p>

        {toggleError && <p role="alert">{toggleError}</p>}
        {state.status === "loading" && <ListLoading />}
        {state.status === "error" && <ListError message={state.message} onRetry={fetchSettings} />}
        {state.status === "loaded" && (
          <ul>
            <li>
              <label htmlFor="global_switch">
                <input
                  id="global_switch"
                  type="checkbox"
                  checked={!state.settings.globally_disabled}
                  onChange={(event) => toggleGlobal(!event.target.checked)}
                />
                All AI capabilities enabled (global switch)
              </label>
            </li>
            {Object.entries(state.settings.capabilities).map(([capability, enabled]) => (
              <li key={capability}>
                <label htmlFor={`capability_${capability}`}>
                  <input
                    id={`capability_${capability}`}
                    type="checkbox"
                    checked={enabled}
                    disabled={state.settings.globally_disabled}
                    onChange={(event) => toggleCapability(capability, event.target.checked)}
                  />
                  {splitLabel(CAPABILITY_LABELS[capability] ?? capability).name}
                </label>
                {splitLabel(CAPABILITY_LABELS[capability] ?? capability).detail && (
                  <details>
                    <summary>What this does</summary>
                    <p className="row-sub">{splitLabel(CAPABILITY_LABELS[capability] ?? capability).detail}</p>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Voice on calls" data-motion-exempt className="ds-card">
        <h2>Voice on calls</h2>
        <p>
          The voice Abel uses when he calls someone on the phone. The Telnyx voice is included in
          the call minute; an ElevenLabs voice uses characters from your ElevenLabs plan. Your
          ElevenLabs key goes in the Telnyx portal — never here, never in a message.
        </p>
        {state.status === "loaded" && (
          <>
            <label htmlFor="call_voice">Voice on calls</label>
            <select
              id="call_voice"
              value={state.settings.call_voice_id ?? ""}
              onChange={(event) => pickCallVoice(event.target.value === "" ? null : event.target.value)}
            >
              <option value="">Telnyx default voice</option>
              {(callVoices?.voices ?? [])
                .filter((voice) => voice.id !== null)
                .map((voice) => (
                  <option key={voice.id} value={voice.id as string}>
                    {voice.label}
                  </option>
                ))}
            </select>
            <p className="row-sub">
              {(callVoices?.voices ?? []).find((voice) => voice.id === state.settings.call_voice_id)
                ?.cost_note ?? "Telnyx voice, included in the call minute — no extra cost."}
            </p>
            {callVoices && !callVoices.configured && (
              <p className="row-sub">
                Calling isn&apos;t connected yet — the full voice list appears once the Telnyx
                number is set up.
              </p>
            )}
          </>
        )}
      </section>
        </>
      )}
      {group === "account" && (
        <>
      <h2 id="settings-account" className="settings-group">Account</h2>
      <section aria-label="Sign out" className="ds-card">
        <button type="button" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </section>
        </>
      )}
    </div>
  );
}
