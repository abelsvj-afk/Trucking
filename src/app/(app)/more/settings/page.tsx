"use client";

// Task 4.6 (TASKS.md), per docs/governance.md: the global + per-capability
// AI kill switches must be "visible, not buried" in the primary UI - this
// is that surface, per docs/design/ui-ux.md's More > Account/Settings
// section. Toggling either switch takes effect for the *next* scheduled
// run only (docs/governance.md) - it never interrupts a run already in
// progress, since revocation "must never require the AI's cooperation"
// but also isn't expected to reach back in time.
//
// Also includes sign-out: docs/design/ui-ux.md assigns "login/session
// management" to this same Account/Settings section, and there was no
// sign-out control anywhere in the app before this - a real usability gap
// for a system that must be genuinely usable (CLAUDE.md), not just this
// task's literal scope, so it's included here rather than left for a
// separate task on the exact page that already exists to hold it.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { createClient } from "@/services/db/client";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import HosCarrierSettings from "@/components/settings/HosCarrierSettings";
import BackgroundTrackingSettings from "@/components/settings/BackgroundTrackingSettings";
import PayTermsSettings from "@/components/settings/PayTermsSettings";
import { useToast } from "@/components/Toast";
import {
  applyThemeChoice,
  resolveThemeChoice,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "@/lib/theme";
import type { AiSettings } from "@/types/ai-settings";

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
];

const CAPABILITY_LABELS: Record<string, string> = {
  industry_intelligence: "Industry intelligence briefings",
  dispatch_helper: "Dispatch helper (translation + reply drafts)",
  bot_chat: "Bot chat (Telegram + web assistant)",
  deep_research: "Deep research engine (watches fuel, rules & news; briefs you when pressure hits)",
  document_extraction: "Document text extraction (reads uploaded paperwork so the assistant can answer questions about it)",
  game_plan: "Game Plan (your target + strategy planner — games your real numbers into a path to the target; projections, never promises)",
  memory_consolidation: "Memory night shift (nightly pass that organizes Abel's memory and stages things he noticed in your chats as proposals for your yes/no — never saves anything on its own)",
  voice_transcription: "Voice transcription (Abel turns your Telegram voice notes into text and works them like typed messages — audio goes to the transcription provider; typical cost is under a cent per note, or free when a free-tier provider is configured)",
  driver_twin: "Driver twin (on Telegram, Abel drafts dispatch replies using your own past sent replies as examples, and tracks how much you edit his drafts — web dispatch drafts don't use the twin yet; off means no examples in drafts and no edit tracking)",
  photo_intelligence: "Photo understanding (when you send Abel a photo, he figures out what it's for — paperwork, the truck, a trailer, the dash, a pre-trip — and asks you with one tap when he isn't sure; off means photos are just filed as documents, like before)",
  live_location: "Live Location (when you share your live location with Abel in Telegram, he keeps only your latest position — it keeps working with the app closed — and may ASK whether to change your duty status when the truck stops for 5 minutes while you're logged Driving; on by default because you start it by sharing; off means nothing is stored and nothing is proposed)",
  auto_duty_switch: "Automatic switch to Driving (when the truck has been moving about a minute and a half while your log says anything but Driving, the app logs Driving for you from the moment it noticed — from the open app or from your Telegram live location with the app closed — and messages you. It only ever switches INTO Driving, never changes earlier entries, and a status you set by hand while moving wins. Planning only, not an ELD. On by default; off means it never changes your log on its own)",
  logging_reminders: "Logging reminders (Abel messages you when a driving, 14-hour, break or cycle clock is about to run out by your own logged hours — 2 hours, 1 hour, 30 minutes and 0 left, with what it means and what to do, even at night — and, in the morning, when your log still says Driving long after it could be true; he only informs or asks, never changes your status; planning only, not an ELD; off by default)",
  maintenance_watch: "Maintenance reminders (Abel watches your maintenance schedules and open defects in the background and messages you when something is due, overdue, or going stale — one digest a day at most, urgent safety/legal items right away; off means he only answers when you ask)",
};

type SettingsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; settings: AiSettings };

export default function AccountSettingsPage() {
  usePageTitle("Settings");
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<SettingsState>({ status: "loading" });
  const [signingOut, setSigningOut] = useState(false);
  // Toggle failures used to roll back silently (audit Section B/F-3):
  // the switch flipped back and said nothing. Now the failure speaks -
  // an inline message here plus a toast.
  const [toggleError, setToggleError] = useState<string | null>(null);
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
    fetchSettings();
  }, [fetchSettings]);

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

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div>
      <PageHeader title="Account & settings" purpose="Your account — and the switches that decide what the AI is allowed to do. Everything AI starts OFF until you turn it on here." />

      <section aria-label="Sign out">
        <button type="button" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </section>

      <HosCarrierSettings />

      <BackgroundTrackingSettings />

      <PayTermsSettings />
      <section aria-label="Appearance">
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

      <section aria-label="AI authorization" data-motion-exempt>
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
                  {CAPABILITY_LABELS[capability] ?? capability}
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
