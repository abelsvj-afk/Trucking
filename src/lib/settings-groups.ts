// Settings are grouped by what the driver is trying to do, not by how the code is organised (audit rank 11).
// Since 2026-11-12 (docs/design/settings-index.md) /more/settings is an INDEX of these six groups and each
// group has its own page at /more/settings/<slug>. `id` is the old in-page anchor: it is kept so a saved
// link to /more/settings#settings-pay still lands on the right page.

import { describeTerms } from "@/lib/pay-projection";
import type { AiSettings } from "@/types/ai-settings";
import type { HosSettings } from "@/types/hos-settings";
import type { EmployerPayProfile } from "@/types/entities";

export const SETTINGS_GROUPS = [
  { id: "settings-pay", slug: "pay", label: "My pay", desc: "Pay terms, which miles are paid, your pay week and payday." },
  { id: "settings-hours", slug: "hours", label: "Hours and truck", desc: "Your carrier's hours-of-service rules and background tracking." },
  { id: "settings-connections", slug: "connections", label: "Connections", desc: "Telegram and the company email inboxes." },
  { id: "settings-look", slug: "look", label: "Appearance and Home", desc: "Light or dark, and what Home shows." },
  { id: "settings-ai", slug: "ai", label: "Abel and AI", desc: "The switches that decide what the AI is allowed to do." },
  { id: "settings-account", slug: "account", label: "Account", desc: "Sign out." },
] as const;

export type SettingsGroupSlug = (typeof SETTINGS_GROUPS)[number]["slug"];

export const settingsPath = (slug: SettingsGroupSlug): string => `/more/settings/${slug}`;

export function groupBySlug(slug: string | null | undefined) {
  return SETTINGS_GROUPS.find((g) => g.slug === slug) ?? null;
}

/** "#settings-pay" (or "settings-pay") -> that group; anything else -> null. Old deep links keep working. */
export function groupByAnchor(hash: string | null | undefined) {
  const id = (hash ?? "").replace(/^#/, "");
  return SETTINGS_GROUPS.find((g) => g.id === id) ?? null;
}

/** "Bot chat (long explanation...)" -> the short name for the row and the explanation behind an expander. */
export function splitLabel(label: string): { name: string; detail: string | null } {
  const open = label.indexOf(" (");
  if (open < 0 || !label.endsWith(")")) return { name: label, detail: null };
  return { name: label.slice(0, open), detail: label.slice(open + 2, -1) };
}

// --- What is set now, in one line per group. Each returns null when the value is unknown: the index then shows
// --- the row without a summary. A summary is never guessed.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MILE_BASIS: Record<string, string> = { loaded: "loaded miles", all: "all miles", practical: "practical miles" };

/** The current terms (newest open profile - the one every pay figure uses), in the driver's words. */
export function summarizePay(profiles: readonly EmployerPayProfile[] | null | undefined): string | null {
  if (!profiles) return null;
  const open = profiles
    .filter((p) => !p.effective_to)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.updated_at.localeCompare(a.updated_at));
  const current = open[0];
  if (!current) return "No pay terms yet";
  const parts = [describeTerms(current)];
  if (current.mile_basis) parts.push(MILE_BASIS[current.mile_basis] ?? current.mile_basis);
  const payday = current.payday_weekday;
  if (payday != null && WEEKDAYS[payday]) parts.push(`payday ${WEEKDAYS[payday]}`);
  return `${current.employer_name}: ${parts.join(", ")}`;
}

export function summarizeHours(hos: HosSettings | null | undefined): string | null {
  if (!hos) return null;
  const [hours, days] = hos.hos_cycle.split("/");
  return `${hours} hours in ${days} days, ${hos.hos_restart_enabled ? "34-hour restart on" : "34-hour restart off"}`;
}

export function summarizeLook(theme: "light" | "dark" | "auto", showBusinessSummary: boolean): string {
  const name = theme === "auto" ? "Follows your phone" : theme === "dark" ? "Dark" : "Light";
  return `${name}; business summary on Home ${showBusinessSummary ? "shown" : "hidden"}`;
}

export function summarizeAi(settings: AiSettings | null | undefined): string | null {
  if (!settings) return null;
  const total = Object.keys(settings.capabilities).length;
  const on = Object.values(settings.capabilities).filter(Boolean).length;
  if (settings.globally_disabled) return `Master switch OFF: no AI runs (${on} of ${total} switches on but held back)`;
  return `Master switch on, ${on} of ${total} switches on`;
}

/** The headline states what the switches ACTUALLY are (live audit 2026-11-07: it said everything AI is off while all 14 were on). */
export function aiSummaryLine(settings: AiSettings | null | undefined): string {
  const base = "Your account — and the switches that decide what the AI is allowed to do.";
  if (!settings) return base;
  const { globally_disabled, capabilities } = settings;
  const total = Object.keys(capabilities).length;
  const on = Object.values(capabilities).filter(Boolean).length;
  if (globally_disabled) return `${base} The master switch is OFF, so no AI runs at all (${on} of ${total} individual switches are on but held back).`;
  if (on === 0) return `${base} All ${total} AI switches are OFF.`;
  if (on === total) return `${base} The master switch is ON and all ${total} AI switches are ON.`;
  return `${base} The master switch is ON; ${on} of ${total} AI switches are ON and ${total - on} are off.`;
}
