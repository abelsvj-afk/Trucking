// News text clipping (V78 live check 2026-11-10 ~8:15 PM CT): the
// Home News card clipped headline/sub-line text at the card's right
// edge MID-WORD (a sub-line ending "…freight relevanc"). Root cause:
// .news-card is a flex row whose text column had no min-width: 0 — a
// flex item will not shrink below its content's min-content size, so
// the text overflowed and was hard-clipped by the card instead of
// wrapping/ellipsizing; the sub-line's own text-overflow: ellipsis
// could never engage for the same reason. jsdom cannot observe
// layout, so — the repo's *-source pattern — these tests pin the CSS
// contract the fix stands on, alongside the render test that the
// text column carries the shrinkable class.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const css = readFileSync(join(ROOT, "src/app/styles/03-components.css"), "utf8");
const card = readFileSync(join(ROOT, "src/components/NewsCard.tsx"), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? "";
}

describe("news card text never hard-clips at the card edge (390px)", () => {
  it("the text column can shrink: flex 1 with min-width 0", () => {
    const body = ruleBody(".news-card-body");
    expect(body).toContain("min-width: 0");
    expect(body).toMatch(/flex:\s*1/);
  });

  it("NewsCard renders its text column with the shrinkable class", () => {
    expect(card).toContain('className="news-card-body"');
  });

  it("the headline wraps and ellipsizes cleanly at two lines (line-clamp, never a mid-word hard clip)", () => {
    const body = ruleBody(".news-card-headline");
    expect(body).toContain("-webkit-line-clamp: 2");
    expect(body).toContain("overflow: hidden");
    expect(body).toContain("overflow-wrap: break-word");
  });

  it("the banner sub-line ellipsizes as a block that can shrink (min-width 0 chain)", () => {
    const body = ruleBody(".news-banner-sub");
    expect(body).toContain("text-overflow: ellipsis");
    expect(body).toContain("white-space: nowrap");
    expect(body).toContain("min-width: 0");
  });
});
