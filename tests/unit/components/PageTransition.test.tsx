// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// vitest globals are off in this repo, so RTL's auto-cleanup never
// registers — clean up by hand or renders leak across tests.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const pathnameRef = { current: "/" as string | null };

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
}));

// matchMedia stub (NewsBanner.test.tsx pattern): no reduced motion
// unless a test says so.
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  onchange: null,
  dispatchEvent: vi.fn(),
}));

import PageTransition, { isDriveSurface } from "@/components/PageTransition";

describe("isDriveSurface", () => {
  it("matches the Drive surface and only the Drive surface", () => {
    expect(isDriveSurface("/smart-path/drive")).toBe(true);
    expect(isDriveSurface("/smart-path")).toBe(false);
    expect(isDriveSurface("/")).toBe(false);
    expect(isDriveSurface(null)).toBe(false);
    expect(isDriveSurface(undefined)).toBe(false);
  });
});

describe("PageTransition", () => {
  it("renders Drive content with NO wrapper (no decorative transition)", () => {
    pathnameRef.current = "/smart-path/drive";
    const { container } = render(
      <PageTransition>
        <p>Glance surface</p>
      </PageTransition>,
    );
    expect(screen.getByText("Glance surface")).toBeTruthy();
    // No element wraps the content — the page renders exactly as-is.
    expect(container.firstChild?.nodeName).toBe("P");
  });

  it("wraps ordinary app content in the transition shell", () => {
    pathnameRef.current = "/loads";
    const { container } = render(
      <PageTransition>
        <p>Loads</p>
      </PageTransition>,
    );
    expect(screen.getByText("Loads")).toBeTruthy();
    // The Motion wrapper div is present on non-Drive surfaces.
    expect(container.firstChild?.nodeName).toBe("DIV");
  });
});
