// V78 live-check defect 2 (2026-11-10): in the Home map's OFF state
// ("Map off — no fresh location"), the ⤢ Full screen + Float controls
// were absolutely positioned over the card, so the Full screen pill
// covered words of the message text ("in your browser" hidden). The
// off-state rule must keep the control row in normal flow; the LIVE
// map keeps its overlaid pair via the generic .home-map-ctl rule.
// CSS layout is not observable in jsdom, so this pins the shipped
// stylesheet the way the repo's other *-source tests pin theirs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/styles/03-components.css"), "utf8");

/** The declaration block for one exact selector (first occurrence). */
function blockFor(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} exists`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("Home map off-state controls never overlap the message (v78 defect 2)", () => {
  it("the off-state control row is in normal flow, not absolutely positioned", () => {
    const block = blockFor(".home-position-hero.home-position-empty .home-map-ctl");
    expect(block).toContain("position: static");
    expect(block).not.toContain("position: absolute");
  });

  it("the live map's control pair stays overlaid (generic rule unchanged)", () => {
    const block = blockFor("\n.home-map-ctl {");
    expect(block).toContain("position: absolute");
  });
});
