// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// vitest globals are off in this repo, so RTL's auto-cleanup never
// registers - clean up by hand or renders leak across tests.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

const { mockPush, navState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  navState: { pathname: "/" as string },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => navState.pathname,
}));

import AbelDrop, { abelCelebrate } from "@/components/AbelDrop";

function stubMatchMedia(reduced: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
}

beforeEach(() => {
  mockPush.mockReset();
  navState.pathname = "/";
  stubMatchMedia(false);
});

describe("AbelDrop", () => {
  it("renders the labelled button", () => {
    render(<AbelDrop />);
    const button = screen.getByRole("button", {
      name: "Open Abel, the assistant",
    });
    expect(button.getAttribute("type")).toBe("button");
  });

  it("tap calls router.push with the Assistant path", () => {
    render(<AbelDrop />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Abel, the assistant" }),
    );
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/more/assistant");
  });

  it("wrapper is pointer-events none and only the button takes events", () => {
    render(<AbelDrop />);
    const root = screen.getByTestId("abel-drop-root");
    expect(root.style.position).toBe("fixed");
    expect(root.style.pointerEvents).toBe("none");
    const button = screen.getByTestId("abel-drop-button");
    expect(button.style.pointerEvents).toBe("auto");
  });

  it("is fully static under prefers-reduced-motion yet still tappable", () => {
    stubMatchMedia(true);
    vi.useFakeTimers();
    render(<AbelDrop />);
    const root = screen.getByTestId("abel-drop-root");
    expect(root.getAttribute("data-motion")).toBe("static");
    // Advancing time must not change anything: no bob/blink/drift timers
    // are scheduled in reduced-motion mode.
    const timersBefore = vi.getTimerCount();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId("abel-drop-root").getAttribute("data-motion")).toBe(
      "static",
    );
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Abel, the assistant" }),
    );
    expect(mockPush).toHaveBeenCalledWith("/more/assistant");
  });

  it("hides while a form field is focused and restores on focusout", () => {
    render(
      <div>
        <input aria-label="amount" />
        <AbelDrop />
      </div>,
    );
    const dock = screen.getByTestId("abel-drop-dock");
    const button = screen.getByTestId("abel-drop-button");
    expect(dock.style.visibility).not.toBe("hidden");

    fireEvent.focusIn(screen.getByLabelText("amount"));
    expect(dock.style.visibility).toBe("hidden");
    expect(button.style.pointerEvents).toBe("none");

    fireEvent.focusOut(screen.getByLabelText("amount"));
    expect(dock.style.visibility).toBe("visible");
    expect(button.style.pointerEvents).toBe("auto");
  });

  it("is not rendered on /smart-path surfaces (plan map + Drive)", () => {
    navState.pathname = "/smart-path/drive";
    const { container } = render(<AbelDrop />);
    expect(container.firstChild).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open Abel, the assistant" }),
    ).toBeNull();
  });

  it("double-tap flips the dock side and persists it", () => {
    render(<AbelDrop />);
    const dock = screen.getByTestId("abel-drop-dock");
    expect(dock.getAttribute("data-side")).toBe("right");
    fireEvent.doubleClick(screen.getByTestId("abel-drop-button"));
    expect(dock.getAttribute("data-side")).toBe("left");
    expect(window.localStorage.getItem("abel-drop-side")).toBe("left");
  });

  it("starts in the entering life state on load (the melt-in moment)", () => {
    render(<AbelDrop />);
    const root = screen.getByTestId("abel-drop-root");
    expect(root.getAttribute("data-life")).toBe("entering");
  });

  it("is static AND never 'entering' under prefers-reduced-motion", () => {
    stubMatchMedia(true);
    render(<AbelDrop />);
    const root = screen.getByTestId("abel-drop-root");
    expect(root.getAttribute("data-life")).toBe("static");
  });

  it("long-press flips the dock side and the following click does not navigate", () => {
    vi.useFakeTimers();
    render(<AbelDrop />);
    const dock = screen.getByTestId("abel-drop-dock");
    const button = screen.getByTestId("abel-drop-button");
    expect(dock.getAttribute("data-side")).toBe("right");
    fireEvent.pointerDown(button);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(dock.getAttribute("data-side")).toBe("left");
    expect(window.localStorage.getItem("abel-drop-side")).toBe("left");
    // The click that follows the long-press pointer-up is consumed.
    fireEvent.click(button);
    expect(mockPush).not.toHaveBeenCalled();
    // A fresh, ordinary tap still opens Abel (parity: the door works).
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(mockPush).toHaveBeenCalledWith("/more/assistant");
  });

  it("a short press does NOT flip the dock (long-press threshold holds)", () => {
    vi.useFakeTimers();
    render(<AbelDrop />);
    const dock = screen.getByTestId("abel-drop-dock");
    const button = screen.getByTestId("abel-drop-button");
    fireEvent.pointerDown(button);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.pointerUp(button);
    expect(dock.getAttribute("data-side")).toBe("right");
  });

  it("abelCelebrate dispatches the abel:celebrate event the drop listens for", () => {
    render(<AbelDrop />);
    const spy = vi.fn();
    window.addEventListener("abel:celebrate", spy);
    act(() => {
      abelCelebrate();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener("abel:celebrate", spy);
  });

  it("cleans up every listener and timer on unmount", () => {
    vi.useFakeTimers();
    const winRemove = vi.spyOn(window, "removeEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<AbelDrop />);
    // Sanity: timers are live while mounted (idle sleep, satellite drift).
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    const winTypes = winRemove.mock.calls.map((c) => c[0]);
    const docTypes = docRemove.mock.calls.map((c) => c[0]);
    expect(winTypes).toContain("abel:celebrate");
    expect(winTypes).toContain("pointerdown");
    expect(winTypes).toContain("scroll");
    expect(docTypes).toContain("focusin");
    expect(docTypes).toContain("focusout");
    expect(vi.getTimerCount()).toBe(0);
    winRemove.mockRestore();
    docRemove.mockRestore();
  });
});
