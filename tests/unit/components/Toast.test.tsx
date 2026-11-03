// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider, useToast, TOAST_AUTO_DISMISS_MS } from "@/components/Toast";

// vitest globals are off in this repo, so RTL's auto-cleanup never
// registers - clean up by hand or renders leak across tests.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Trigger() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success("Saved")}>
        save
      </button>
      <button type="button" onClick={() => toast.error("Couldn't save. Try again.")}>
        fail
      </button>
    </>
  );
}

describe("Toast", () => {
  it("renders a success toast in the polite live region, distinct from error", () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(region.querySelector('[data-variant="success"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "fail" }));
    expect(screen.getByText("Couldn't save. Try again.")).toBeTruthy();
    expect(region.querySelector('[data-variant="error"]')).toBeTruthy();
  });

  it("auto-dismisses after ~4.5s", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS + 50);
    });
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("can be dismissed by hand", () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
