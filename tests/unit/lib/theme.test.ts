// Theme choice helpers (parked decision (d)): the pure resolution
// logic behind src/lib/theme.ts - the shipped default is "auto" and
// anything unrecognized falls back to it.

import { describe, expect, it } from "vitest";
import {
  THEME_DEFAULT,
  THEME_STORAGE_KEY,
  resolveEffectiveTheme,
  resolveThemeChoice,
  themeAttributeFor,
} from "@/lib/theme";

describe("theme choice (parked decision (d))", () => {
  it("ships Auto as the default", () => {
    expect(THEME_DEFAULT).toBe("auto");
    expect(THEME_STORAGE_KEY).toBe("trucking-theme");
  });

  it("resolves stored values, defaulting missing/garbage to auto", () => {
    expect(resolveThemeChoice("light")).toBe("light");
    expect(resolveThemeChoice("dark")).toBe("dark");
    expect(resolveThemeChoice("auto")).toBe("auto");
    expect(resolveThemeChoice(null)).toBe("auto");
    expect(resolveThemeChoice(undefined)).toBe("auto");
    expect(resolveThemeChoice("sepia")).toBe("auto");
    expect(resolveThemeChoice("")).toBe("auto");
  });

  it("auto follows the OS; explicit picks win over the OS", () => {
    expect(resolveEffectiveTheme("auto", true)).toBe("dark");
    expect(resolveEffectiveTheme("auto", false)).toBe("light");
    expect(resolveEffectiveTheme("dark", false)).toBe("dark");
    expect(resolveEffectiveTheme("light", true)).toBe("light");
  });

  it("auto means no data-theme attribute; explicit picks set it", () => {
    expect(themeAttributeFor("auto")).toBeNull();
    expect(themeAttributeFor("dark")).toBe("dark");
    expect(themeAttributeFor("light")).toBe("light");
  });
});
