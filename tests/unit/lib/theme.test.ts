// Theme choice helpers: the pure resolution logic behind
// src/lib/theme.ts. The shipped default was "auto" under parked
// decision (d); the owner settled it DARK on 2026-11-10 (the approved
// mockup is dark-only — conformance fix D1), so anything unrecognized
// now falls back to "dark".

import { describe, expect, it } from "vitest";
import {
  THEME_DEFAULT,
  THEME_STORAGE_KEY,
  resolveEffectiveTheme,
  resolveThemeChoice,
  themeAttributeFor,
} from "@/lib/theme";

describe("theme choice (default settled dark 2026-11-10)", () => {
  it("ships Dark as the default — the approved mockup's scheme", () => {
    expect(THEME_DEFAULT).toBe("dark");
    expect(THEME_STORAGE_KEY).toBe("trucking-theme");
  });

  it("resolves stored values, defaulting missing/garbage to the dark default", () => {
    expect(resolveThemeChoice("light")).toBe("light");
    expect(resolveThemeChoice("dark")).toBe("dark");
    expect(resolveThemeChoice("auto")).toBe("auto");
    expect(resolveThemeChoice(null)).toBe("dark");
    expect(resolveThemeChoice(undefined)).toBe("dark");
    expect(resolveThemeChoice("sepia")).toBe("dark");
    expect(resolveThemeChoice("")).toBe("dark");
  });

  it("auto follows the OS; explicit picks win over the OS", () => {
    expect(resolveEffectiveTheme("auto", true)).toBe("dark");
    expect(resolveEffectiveTheme("auto", false)).toBe("light");
    expect(resolveEffectiveTheme("dark", false)).toBe("dark");
    expect(resolveEffectiveTheme("light", true)).toBe("light");
  });

  it("auto means no data-theme attribute; explicit picks and the dark default set it", () => {
    expect(themeAttributeFor(THEME_DEFAULT)).toBe("dark");
    expect(themeAttributeFor("auto")).toBeNull();
    expect(themeAttributeFor("dark")).toBe("dark");
    expect(themeAttributeFor("light")).toBe("light");
  });
});
