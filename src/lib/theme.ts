// Theme choice — SETTLED BY THE OWNER 2026-11-10 (conformance fix D1).
//
// History: the audit (2026-11-01, Section D-3) recommended an in-app
// Light / Dark / Auto choice in Settings and shipped "auto" (the OS
// decides) as an unsettled default — parked decision (d). The owner
// then approved the UI/UX redesign whose mockups are drawn ONLY in
// the dark black-and-gold scheme, and the spec (§2.6) states "dark
// scheme is his working scheme". When PR #52 shipped with the default
// still "auto", every device whose OS was in light mode rendered the
// cream/white light scheme instead — the owner compared live Home
// against the approved mockup and rejected it. The default is now
// DARK: a device with no stored pick renders the approved design.
// The Settings segmented control still offers Light / Dark / Auto and
// an explicit pick always wins (it is stored in localStorage and the
// pre-paint init script in src/app/layout.tsx applies it as a
// data-theme attribute the stylesheets key off:
//   dark tokens apply when (OS dark AND NOT data-theme="light")
//   OR data-theme="dark" OR no attribute at all — the base @theme
//   tokens ARE the dark scheme, §2.6 of the spec).

export type ThemeChoice = "light" | "dark" | "auto";

/** Settled 2026-11-10: the shipped default theme choice is the dark
 *  black-and-gold scheme of the approved mockup. */
export const THEME_DEFAULT: ThemeChoice = "dark";

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

/** Pure: the data-theme attribute value for a choice. "auto" means NO
 *  attribute, so the CSS media query alone decides; explicit picks set
 *  the attribute. The shipped default (dark, settled 2026-11-10) maps
 *  to "dark" — with no stored pick the pre-paint script still sets the
 *  attribute, because the base tokens alone do not decide the scheme
 *  (the light scheme is the base; dark needs the attribute or an
 *  OS-dark media match). */
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
