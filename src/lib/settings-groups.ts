// Settings are grouped by what the driver is trying to do, not by how the code is organised (audit rank 11).

export const SETTINGS_GROUPS = [
  { id: "settings-pay", label: "My pay" },
  { id: "settings-hours", label: "Hours and truck" },
  { id: "settings-connections", label: "Connections" },
  { id: "settings-look", label: "Appearance and Home" },
  { id: "settings-ai", label: "Abel and AI" },
  { id: "settings-account", label: "Account" },
] as const;

/** "Bot chat (long explanation...)" -> the short name for the row and the explanation behind an expander. */
export function splitLabel(label: string): { name: string; detail: string | null } {
  const open = label.indexOf(" (");
  if (open < 0 || !label.endsWith(")")) return { name: label, detail: null };
  return { name: label.slice(0, open), detail: label.slice(open + 2, -1) };
}

