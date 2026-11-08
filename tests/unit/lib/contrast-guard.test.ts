// Contrast guard (UI/UX audit 2026-11-01, Section D): parses the
// token hexes out of src/app/globals.css and asserts the pairs the
// audit failed now meet their bars - 4.5:1 for normal text, 3.0:1 for
// non-text boundaries/focus (WCAG 1.4.11). If someone lightens a
// token back, this test is the tripwire.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// globals.css is an ordered list of @imports of ./styles/*.css (file
// decomposition); the guard reads the parts in that same cascade order.
const appDir = path.resolve(process.cwd(), "src/app");
const css = [...readFileSync(path.join(appDir, "globals.css"), "utf8").matchAll(/@import "\.\/(styles\/[^"]+)";/g)]
  .map((m) => readFileSync(path.join(appDir, m[1]!), "utf8"))
  .join("\n");
const driveMap = readFileSync(
  path.resolve(process.cwd(), "src/components/DriveMap.tsx"),
  "utf8",
);

function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const v = [0, 2, 4]
    .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
}

function ratio(a: string, b: string): number {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

const lightBlock = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
const darkBlock = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`token ${name} not found`);
  return match[1]!;
}
const L = (name: string) => token(lightBlock, name);
const D = (name: string) => token(darkBlock, name);

function pinColor(kind: string): string {
  const match = driveMap.match(new RegExp(`${kind}:\\s*"(#[0-9a-fA-F]{6})"`));
  if (!match) throw new Error(`pin color ${kind} not found`);
  return match[1]!;
}

describe("contrast guard - light scheme", () => {
  it("badge/semantic text pairs meet 4.5:1", () => {
    expect(ratio(L("--color-success"), L("--color-success-light"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(L("--color-warning"), L("--color-warning-light"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(L("--color-danger"), L("--color-danger-light"))).toBeGreaterThanOrEqual(4.5);
  });

  it("paused/segmented muted-strong on the border track meets 4.5:1", () => {
    expect(ratio(L("--color-text-muted-strong"), L("--color-border"))).toBeGreaterThanOrEqual(4.5);
    // ...and the global muted token passes on plain white (black-and-gold palette).
    expect(ratio(L("--color-text-muted"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("muted-strong on the primary-light tint and on white meets 4.5:1", () => {
    expect(ratio(L("--color-text-muted-strong"), L("--color-primary-light"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(L("--color-text-muted-strong"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("input resting border meets the 3:1 non-text bar on white", () => {
    expect(L("--color-border-strong")).toBe("#8c8573");
    expect(ratio(L("--color-border-strong"), "#ffffff")).toBeGreaterThanOrEqual(3.0);
    expect(css).toMatch(/border: 1px solid var\(--color-border-strong\)/);
  });

  it("input focus is a visible outline, not the old primary-light glow", () => {
    expect(css).toMatch(/outline: 2px solid var\(--color-primary\)/);
    expect(css).not.toContain("box-shadow: 0 0 0 3px var(--color-primary-light)");
    expect(ratio(L("--color-primary"), "#ffffff")).toBeGreaterThanOrEqual(3.0);
  });

  it("h2 headings use the full text color", () => {
    const h2 = css.match(/h2 \{([^}]*)\}/);
    expect(h2?.[1]).toContain("color: var(--color-text)");
    expect(h2?.[1]).toContain("font-size: 0.875rem");
  });
});

describe("contrast guard - dark scheme", () => {
  it("primary buttons: the on-primary text meets 4.5:1 on the gold button token", () => {
    expect(ratio(D("--color-on-primary"), D("--color-primary-button"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(D("--color-on-primary"), D("--color-primary-button-hover"))).toBeGreaterThanOrEqual(4.5);
  });

  it("link primary is gold and passes on the dark surface", () => {
    expect(D("--color-primary")).toBe("#e5b83a");
    expect(ratio(D("--color-primary"), D("--color-surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it("dark input border meets 3:1 on the dark surface", () => {
    expect(ratio(D("--color-border-strong"), D("--color-surface"))).toBeGreaterThanOrEqual(3.0);
  });

  it("dark muted-strong on the dark tint meets 4.5:1", () => {
    expect(ratio(D("--color-text-muted-strong"), D("--color-primary-light"))).toBeGreaterThanOrEqual(4.5);
  });

  it("dark tokens apply via the data-theme mechanism (auto default)", () => {
    expect(css).toContain(":root:not([data-theme=\"light\"])");
    expect(css).toContain(":root[data-theme=\"dark\"]");
  });
});

describe("contrast guard - map pins and entrance motion", () => {
  it("white pin letters on DriveMap fuel/pickup pins meet 4.5:1", () => {
    expect(ratio("#ffffff", pinColor("fuel"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio("#ffffff", pinColor("pickup"))).toBeGreaterThanOrEqual(4.5);
  });

  it("entrance animations are off (no tabPop, no section/li fadeInUp)", () => {
    expect(css).not.toContain("tabPop");
    expect(css).not.toMatch(/section \{[^}]*animation: fadeInUp/);
    expect(css).not.toMatch(/main li \{[^}]*animation: fadeInUp/);
    // The reduced-motion guard must survive.
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("black-and-gold identity (owner ruling 2026-11-07, option A)", () => {
  it("light-scheme buttons and links pass with the gold tokens, and no blue primary survives in the stylesheets", () => {
    expect(ratio(L("--color-on-primary"), L("--color-primary-button"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(L("--color-on-primary"), L("--color-primary-button-hover"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(L("--color-primary"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(L("--color-primary"), L("--color-primary-light"))).toBeGreaterThanOrEqual(4.5);
    for (const blue of ["#2563eb", "#1d4ed8", "#3b82f6", "#60a5fa", "#93c5fd", "#172554", "#eff6ff", "#0f2040"]) {
      expect(css.toLowerCase()).not.toContain(blue);
    }
  });
  it("no button paints white text on the gold background", () => {
    expect(css).not.toMatch(/background-color: var\(--color-primary-button(?:-hover)?\);\s*\n\s*color: white;/);
  });
});

describe("touch targets (audit rank 7)", () => {
  it("the news pagination dots keep a 44px hit area through an invisible extension", () => {
    expect(css).toMatch(/\.news-banner-dot::after \{[^}]*inset: -17px/);
    expect(css).toMatch(/\.news-banner-dot \{[^}]*width: 0\.625rem/);
  });
});
