import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BOTTOM_TABS } from "@/lib/nav-config";
import {
  HomeGlyph,
  MoneyGlyph,
  MoreGlyph,
  PackageGlyph,
  RoadGlyph,
  SparkleGlyph,
} from "@/lib/tab-glyphs";

// HOME MOCKUP-TRUE (owner order 2026-11-10): the tab bar carries the
// approved mockup's glyph set — Home ⌂ · Loads 📦 · Smart Path 🛣 ·
// Money ▤ · Abel ✦ (the sparkle, never a robot) · More ••• — as inline
// SVGs. These tests pin the SHAPES so a later restyle cannot silently
// swap a glyph for a different symbol (the v77/v78 failure mode).

function pathsOf(Glyph: (typeof BOTTOM_TABS)[number]["Icon"]): string[] {
  const html = renderToStaticMarkup(createElement(Glyph, { size: 19 }));
  return [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]!);
}

describe("tab glyphs (mockup set)", () => {
  it("gives every tab a DISTINCT glyph", () => {
    const seen = new Set(BOTTOM_TABS.map((t) => pathsOf(t.Icon).join("|")));
    expect(seen.size).toBe(BOTTOM_TABS.length);
  });

  it("pins each tab to its mockup glyph, in tab order", () => {
    expect(BOTTOM_TABS.map((t) => t.Icon)).toEqual([
      HomeGlyph,
      PackageGlyph,
      RoadGlyph,
      MoneyGlyph,
      SparkleGlyph,
      MoreGlyph,
    ]);
  });

  it("Abel's glyph is the four-point sparkle ✦ — never a robot", () => {
    const abel = BOTTOM_TABS.find((t) => t.label === "Abel")!;
    expect(abel.Icon).toBe(SparkleGlyph);
    // The sparkle's single path: a four-point star.
    expect(pathsOf(abel.Icon)).toEqual([
      "M12 1.8c.9 5.9 2.5 7.9 8.4 10.2-5.9 2.3-7.5 4.3-8.4 10.2C11.1 16.3 9.5 14.3 3.6 12 9.5 9.7 11.1 7.7 12 1.8z",
    ]);
  });

  it("every glyph renders a filled SVG in currentColor (gold active state carries it)", () => {
    for (const tab of BOTTOM_TABS) {
      const html = renderToStaticMarkup(createElement(tab.Icon, { size: 19 }));
      expect(html).toContain("<svg");
      expect(html).toContain('fill="currentColor"');
      expect(html).toContain('width="19"');
    }
  });
});
