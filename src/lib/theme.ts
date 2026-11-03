// Theme choice — PARKED OWNER DECISION (d).
//
// The audit (2026-11-01, Section D-3) recommended an in-app
// Light / Dark / Auto choice in Settings. The owner has NOT settled
// this decision yet; what ships here is the audit's recommended
// default WITHOUT settling it: Auto, i.e. today's behavior where the
// OS decides. To flip the shipped default later, change THEME_DEFAULT
// below — that one line is the flip location. The Settings segmented
// control writes the owner's pick to localStorage, and the pre-paint
// init script in src/app/layout.tsx applies it as a data-theme
// attribute that src/app/globals.css keys off:
//   dark tokens apply when (OS dark AND NOT data-theme="light")
//   OR data-theme="dark".

export type ThemeChoice = "light" | "dark" | "auto";

/** Parked decision (d): the shipped default theme choice. Flip here. */
export const THEME_DEFAULT: ThemeChoice = "auto";

export const THEME_STORAGE_KEY = "trucking-theme";

/** Pure: anything that is not an explicit "light"/"dark" pick
 *  (missing, "auto", or garbage from an older build) resolves to the
 *  shipped default. */
export function resolveThemeChoice(stored: string | null | undefined): ThemeChoice {
  if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  return THEME_DEFAULT;
}

/** Pure: the scheme that should actually render for a choice, given
 *  the OS preference. "auto" follows the OS; explicit picks win. */
export function resolveEffectiveTheme(
  choice: ThemeChoice,
  osPrefersDark: boolean,
): "light" | "dark" {
  if (choice === "dark") return "dark";
  if (choice === "light") return "light";
  return osPrefersDark ? "dark" : "light";
}

/** Pure: the data-theme attribute value for a choice. "auto" (or the
 *  default) means NO attribute, so the CSS media query alone decides;
 *  explicit picks set the attribute. */
export function themeAttributeFor(choice: ThemeChoice): "light" | "dark" | null {
  return choice === "auto" ? null : choice;
}

/** Read the stored choice (browser only; defaults on the server). */
export function getStoredThemeChoice(): ThemeChoice {
  if (typeof window === "undefined") return THEME_DEFAULT;
  try {
    return resolveThemeChoice(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return THEME_DEFAULT;
  }
}

/** Persist a choice and apply it to the document right away. */
export function applyThemeChoice(choice: ThemeChoice): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage can be unavailable (private mode); the attribute below
    // still applies the choice for this session.
  }
  const attribute = themeAttributeFor(choice);
  if (attribute === null) {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = attribute;
  }
}
