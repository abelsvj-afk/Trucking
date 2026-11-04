// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// vitest globals are off in this repo, so RTL's auto-cleanup never
// registers — clean up by hand or renders leak across tests.
afterEach(() => {
  cleanup();
});

// Same matchMedia stub pattern as NewsBanner.test.tsx: Motion's
// useReducedMotion reads prefers-reduced-motion through matchMedia.
function stubMatchMedia(reduced: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
}

import WordReveal from "@/components/WordReveal";

const HEADLINE = "Diesel prices climb again this week";

beforeEach(() => {
  stubMatchMedia(false);
});

describe("WordReveal", () => {
  it("renders every word of the headline", () => {
    const { container } = render(<WordReveal text={HEADLINE} />);
    const spans = container.querySelectorAll(".word-reveal-word");
    expect(spans.length).toBe(HEADLINE.split(" ").length);
    expect(container.textContent?.replace(/\s+/g, " ").trim()).toBe(HEADLINE);
  });

  it("exposes the whole headline as one accessible label", () => {
    const { container } = render(<WordReveal text={HEADLINE} />);
    expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(HEADLINE);
  });

  it("under reduced motion renders the plain headline with no word spans", () => {
    stubMatchMedia(true);
    const { container } = render(<WordReveal text={HEADLINE} />);
    expect(container.querySelectorAll(".word-reveal-word").length).toBe(0);
    expect(container.textContent).toBe(HEADLINE);
  });
});
