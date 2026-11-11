// Bottom tab-bar glyphs — HOME MOCKUP-TRUE (owner order 2026-11-10).
//
// The approved Home mockup draws the six tabs as filled glyphs:
//   Home ⌂ · Loads 📦 · Smart Path 🛣 · Money ▤ · Abel ✦ · More •••
// Emoji render inconsistently across platforms (full-colour vs
// unrendered boxes), so each mockup glyph is reproduced here as an
// inline SVG with the same shape and visual weight, drawn in
// currentColor so the bar's gold-bright active state carries them.
// Shapes are copied from the mockup glyphs — never swapped for a
// different symbol. The Abel tab is the sparkle (✦), never a robot.
import type { ComponentType, CSSProperties } from "react";
import { createElement } from "react";

export type TabGlyph = ComponentType<{
  size?: number;
  className?: string;
  style?: CSSProperties;
}>;

function glyph(paths: string[], fillRule?: "evenodd"): TabGlyph {
  return function TabGlyphSvg({ size = 19, className, style }: { size?: number; className?: string; style?: CSSProperties }) {
    return createElement(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        "aria-hidden": true,
        focusable: false,
        className,
        style,
      },
      paths.map((d, i) =>
        createElement("path", { key: i, d, fill: "currentColor", ...(fillRule ? { fillRule } : {}) }),
      ),
    );
  };
}

// ⌂ — house: pitched roof, chimney, body, doorway cut out.
export const HomeGlyph = glyph([
  "M12 2.6 2.8 11.1c-.35.3-.38.83-.07 1.2.3.36.84.4 1.22.1L5 11.5v8.3c0 .66.54 1.2 1.2 1.2h3.6c.66 0 1.2-.54 1.2-1.2v-4.9c0-.55.45-1 1-1s1 .45 1 1v4.9c0 .66.54 1.2 1.2 1.2h3.6c.66 0 1.2-.54 1.2-1.2v-8.3l1.05.91c.38.3.92.26 1.22-.1.31-.37.28-.9-.07-1.2L13.6 4.6V3.2c0-.44-.36-.8-.8-.8h-.4c-.44 0-.4.36-.4.8v.5z",
]);

// 📦 — package: isometric box with top flaps and the packing-tape cross.
export const PackageGlyph = glyph([
  "M12 2.2 3 6.6v10.8l9 4.4 9-4.4V6.6L12 2.2zm7.2 5.05-3.05 1.5-7.1-3.5L12 3.8l7.2 3.45zM4.6 8.15l7 3.45v8.1l-7-3.45V8.15zm14.8 0v8.1l-7 3.45v-8.1l7-3.45zM10.9 10.4 7 8.5l1.05-.55 2.85 1.4v1.05zm2.2 0V9.35l2.85-1.4L17 8.5l-3.9 1.9z",
]);

// 🛣 — motorway: two lanes converging to the horizon, dashes between.
export const RoadGlyph = glyph([
  "M9.4 3.2c.35.05.6.34.57.7L8.6 20.35c-.03.4-.35.7-.76.7H5.6c-.52 0-.88-.53-.7-1.02L7.9 3.75c.1-.3.42-.5.74-.47l.76.03zm5.2 0 .76-.03c.32-.02.64.17.74.47l3 16.28c.18.49-.18 1.02-.7 1.02h-2.24c-.41 0-.73-.3-.76-.7L13.03 3.9c-.03-.36.22-.65.57-.7zM12 5.1c.42 0 .75.33.74.74l-.06 1.7c-.01.4-.34.72-.74.72s-.73-.32-.74-.72l-.04-1.7C11.15 5.43 11.58 5.1 12 5.1zm0 4.9c.42 0 .76.33.75.75l-.05 2c-.01.41-.34.73-.75.73s-.74-.32-.75-.73l-.04-2c-.01-.42.33-.75.84-.75zm0 5.3c.43 0 .77.34.76.76l-.05 2.3c-.01.41-.35.74-.76.74s-.75-.33-.76-.74l-.04-2.3c-.01-.42.34-.76.85-.76z",
]);

// ▤ — the mockup's Money glyph: a ruled ledger page (the money list).
export const MoneyGlyph = glyph([
  "M5 3h14c.55 0 1 .45 1 1v16c0 .55-.45 1-1 1H5c-.55 0-1-.45-1-1V4c0-.55.45-1 1-1zm2 3.4v2.1h4.4V6.4H7zm6.2 0v2.1H17V6.4h-3.8zM7 10.6v2.1h4.4v-2.1H7zm6.2 0v2.1H17v-2.1h-3.8zM7 14.8v2.1h4.4v-2.1H7zm6.2 0v2.1H17v-2.1h-3.8z",
]);

// ✦ — the sparkle: four-point star, the drop's mark (never a robot).
export const SparkleGlyph = glyph([
  "M12 1.8c.9 5.9 2.5 7.9 8.4 10.2-5.9 2.3-7.5 4.3-8.4 10.2C11.1 16.3 9.5 14.3 3.6 12 9.5 9.7 11.1 7.7 12 1.8z",
]);

// ••• — three dots.
export const MoreGlyph = glyph([
  "M4.9 10.4a1.9 1.9 0 1 1 0 3.2 1.9 1.9 0 0 1 0-3.2zm7.1 0a1.9 1.9 0 1 1 0 3.2 1.9 1.9 0 0 1 0-3.2zm7.1 0a1.9 1.9 0 1 1 0 3.2 1.9 1.9 0 0 1 0-3.2z",
]);
