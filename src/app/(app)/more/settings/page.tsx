"use client";

// Settings index (docs/design/settings-index.md, owner-approved 2026-11-12): six rows, one per group, each
// showing what is set now and opening that group on its own page. It replaces one page about eleven phone
// screens long. No setting lives here; nothing here can change a setting - in particular the AI kill switches
// (docs/governance.md) are shown as a summary only and are changed on their own page.
//
// A row's summary comes from the same endpoint its page reads. If that read fails, the row shows no summary
// and still opens: a summary is never guessed.

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import HubRow from "@/components/HubRow";
import { resolveThemeChoice, THEME_STORAGE_KEY } from "@/lib/theme";
import { resolveShowBusinessSummary, HOME_BUSINESS_SUMMARY_STORAGE_KEY } from "@/lib/home-display";
import {
  SETTINGS_GROUPS,
  aiSummaryLine,
  groupByAnchor,
  settingsPath,
  summarizeAi,
  summarizeHours,
  summarizeLook,
  summarizePay,
  type SettingsGroupSlug,
} from "@/lib/settings-groups";
import type { AiSettings } from "@/types/ai-settings";
import type { HosSettings } from "@/types/hos-settings";
import type { EmployerPayProfile } from "@/types/entities";

function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

export default function SettingsIndexPage() {
  usePageTitle("Settings");
  const router = useRouter();
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [hos, setHos] = useState<HosSettings | null>(null);
  const [profiles, setProfiles] = useState<EmployerPayProfile[] | null>(null);

  // Old deep links: /more/settings#settings-pay opens the pay page.
  useEffect(() => {
    const target = groupByAnchor(window.location.hash);
    if (target) router.replace(settingsPath(target.slug));
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    const keep = <T,>(set: (value: T) => void) => (value: T) => {
      if (!cancelled) set(value);
    };
    // Each summary is independent: one failing read leaves that row without a summary, nothing more.
    apiClient.getAiSettings().then(keep(setAi)).catch(() => undefined);
    apiClient.getHosSettings().then(keep(setHos)).catch(() => undefined);
    apiClient
      .list<EmployerPayProfile>("pay-profiles")
      .then((result) => keep(setProfiles)(result.data))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const storedTheme = useSyncExternalStore(subscribeStorage, () => window.localStorage.getItem(THEME_STORAGE_KEY), () => null);
  const storedSummary = useSyncExternalStore(
    subscribeStorage,
    () => window.localStorage.getItem(HOME_BUSINESS_SUMMARY_STORAGE_KEY),
    () => null,
  );

  const summaries: Record<SettingsGroupSlug, string | null> = {
    pay: summarizePay(profiles),
    hours: summarizeHours(hos),
    connections: null,
    look: summarizeLook(resolveThemeChoice(storedTheme), resolveShowBusinessSummary(storedSummary)),
    ai: summarizeAi(ai),
    account: null,
  };

  return (
    <div>
      <PageHeader title="Account & settings" purpose={aiSummaryLine(ai)} />
      <ul aria-label="Settings sections">
        {SETTINGS_GROUPS.map((group) => (
          <li key={group.slug}>
            <HubRow
              href={settingsPath(group.slug)}
              label={group.label}
              desc={
                summaries[group.slug] ? (
                  <>
                    {group.desc} <strong>{summaries[group.slug]}</strong>
                  </>
                ) : (
                  group.desc
                )
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
