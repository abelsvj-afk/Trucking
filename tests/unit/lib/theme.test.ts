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
  themeBootstrapScript,
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

  // V78 live-check instability (2026-11-10 ~8:15 PM CT): across plain
  // reloads with NO setting touched, Home flipped dark -> light and
  // stayed light. The pre-paint bootstrap is the only applier of the
  // theme, and it was a hand-duplicated copy of the resolver living in
  // the layout — the two could drift, and nothing re-asserted the
  // attribute after load. The bootstrap is now GENERATED from the same
  // resolver (single source) and these tests pin its behaviour by
  // executing it the way the browser does.
  describe("themeBootstrapScript (the layout's pre-paint script, generated)", () => {
    function runBootstrap(stored: string | null, storageThrows = false) {
      const dataset: Record<string, string> = {};
      const fakeDocument = { documentElement: { dataset } };
      const fakeWindow = {
        localStorage: {
          getItem: () => {
            if (storageThrows) throw new Error("blocked");
            return stored;
          },
        },
      };
      const fn = new Function("window", "document", themeBootstrapScript());
      fn(fakeWindow, fakeDocument);
      return dataset.theme;
    }

    it("no stored pick -> dark, every load (the shipped default)", () => {
      expect(runBootstrap(null)).toBe("dark");
      expect(runBootstrap(null)).toBe("dark");
      expect(runBootstrap("garbage")).toBe("dark");
    });

    it("an explicit pick wins, every load", () => {
      expect(runBootstrap("light")).toBe("light");
      expect(runBootstrap("dark")).toBe("dark");
    });

    it("auto removes the attribute so the OS decides", () => {
      expect(runBootstrap("auto")).toBeUndefined();
    });

    it("unreadable storage still lands on the dark default, never the light base", () => {
      expect(runBootstrap(null, true)).toBe("dark");
    });

    it("the script reads the one storage key and nothing else", () => {
      expect(themeBootstrapScript()).toContain(THEME_STORAGE_KEY);
    });
  });
});
