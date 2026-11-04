// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import Sheet from "@/components/Sheet";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Sheet
          title="Your day"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <button>First</button>
          <input aria-label="Field" />
          <button>Last</button>
        </Sheet>
      )}
    </div>
  );
}

describe("Sheet", () => {
  it("is a labelled modal dialog and moves focus into it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open"));
    const dialog = screen.getByRole("dialog", { name: "Your day" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("locks page scroll while open and restores it, and returns focus, on close", () => {
    render(<Harness />);
    const opener = screen.getByText("Open");
    opener.focus();
    fireEvent.click(opener);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Close Your day" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("Escape closes it", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByText("Open"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a tap on the backdrop closes it; a tap inside does not", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open"));
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(document.querySelector(".sheet-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Tab wraps inside the dialog (focus can't leak to the page behind)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open"));
    const buttons = screen.getByRole("dialog").querySelectorAll("button, input");
    const last = buttons[buttons.length - 1] as HTMLElement;
    const first = buttons[0] as HTMLElement;
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("Sheet focus (pitfall hunt)", () => {
  it("opens with focus on the first FIELD, not the close button (Enter must not dismiss it by accident)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open"));
    expect((document.activeElement as HTMLElement).textContent).toBe("First");
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Close Your day" }));
  });
});
