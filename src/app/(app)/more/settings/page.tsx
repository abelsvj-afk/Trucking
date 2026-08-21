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

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { createClient } from "@/services/db/client";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import type { AiSettings } from "@/types/ai-settings";

const CAPABILITY_LABELS: Record<string, string> = {
  industry_intelligence: "Industry intelligence briefings",
};

type SettingsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; settings: AiSettings };

export default function AccountSettingsPage() {
  usePageTitle("Settings");
  const router = useRouter();
  const [state, setState] = useState<SettingsState>({ status: "loading" });
  const [signingOut, setSigningOut] = useState(false);

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
    setState({ status: "loaded", settings: { ...previous, globally_disabled: nextValue } });
    try {
      const settings = await apiClient.updateAiSettings({ globally_disabled: nextValue });
      setState({ status: "loaded", settings });
    } catch {
      setState({ status: "loaded", settings: previous });
    }
  }

  async function toggleCapability(capability: string, nextValue: boolean) {
    if (state.status !== "loaded") return;
    const previous = state.settings;
    setState({
      status: "loaded",
      settings: { ...previous, capabilities: { ...previous.capabilities, [capability]: nextValue } },
    });
    try {
      const settings = await apiClient.updateAiSettings({ capabilities: { [capability]: nextValue } });
      setState({ status: "loaded", settings });
    } catch {
      setState({ status: "loaded", settings: previous });
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
      <h1>Account &amp; settings</h1>

      <section aria-label="Sign out">
        <button type="button" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </section>

      <section aria-label="AI authorization">
        <h2>AI authorization</h2>
        <p>
          These control what the AI is allowed to run automatically. Turning a switch off takes
          effect before the next scheduled run — it never interrupts one already in progress.
        </p>

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
