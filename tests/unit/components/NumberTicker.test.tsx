// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

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

import NumberTicker from "@/components/NumberTicker";

const formatDollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

beforeEach(() => {
  stubMatchMedia(false);
});

describe("NumberTicker", () => {
  it("animates to the final value on mount", async () => {
    const { container } = render(<NumberTicker value={123456} format={formatDollars} />);
    await waitFor(() => expect(container.textContent).toBe("$1234.56"), { timeout: 3000 });
  });

  it("animates to the new value when the value changes", async () => {
    const { container, rerender } = render(<NumberTicker value={10000} format={formatDollars} />);
    await waitFor(() => expect(container.textContent).toBe("$100.00"), { timeout: 3000 });
    rerender(<NumberTicker value={25050} format={formatDollars} />);
    await waitFor(() => expect(container.textContent).toBe("$250.50"), { timeout: 3000 });
  });

  it("under reduced motion renders the final value statically, immediately", () => {
    stubMatchMedia(true);
    const { container } = render(<NumberTicker value={98765} format={formatDollars} />);
    expect(container.textContent).toBe("$987.65");
    const span = container.querySelector("span");
    expect(span?.style.fontVariantNumeric).toBe("tabular-nums");
  });
});
