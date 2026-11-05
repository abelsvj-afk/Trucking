// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  // @ts-expect-error test cleanup
  delete navigator.permissions;
});

const motionHolder: { state: "moving" | "stopped" | "unknown" } = { state: "stopped" };
const motionHookCalls = vi.fn();
vi.mock("@/lib/use-vehicle-motion", () => ({
  useVehicleMotion: () => {
    motionHookCalls();
    return motionHolder.state;
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/money/expenses/new" }));

import MotionLock, { setFormsInert } from "@/components/MotionLock";

function setPermission(state: "granted" | "denied" | "prompt" | null) {
  if (state === null) return;
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: vi.fn().mockResolvedValue({ state, onchange: null }) },
  });
}

function Page({ extra = false }: { extra?: boolean }) {
  return (
    <div>
      <MotionLock />
      <main id="main-content">
        <form aria-label="Expense">
          <input aria-label="Amount" />
        </form>
        {extra && (
          <form aria-label="Late form">
            <input aria-label="Late" />
          </form>
        )}
      </main>
    </div>
  );
}

async function mount(ui: React.ReactElement) {
  const r = render(ui);
  await act(async () => {});
  await act(async () => {});
  return r;
}

beforeEach(() => {
  motionHolder.state = "stopped";
  motionHookCalls.mockClear();
});

describe("MotionLock (app-wide driving lock)", () => {
  it("never watches GPS - so can never prompt for location - unless permission is already granted", async () => {
    setPermission("prompt");
    await mount(<Page />);
    expect(motionHookCalls).not.toHaveBeenCalled();
    cleanup();
    setPermission("denied");
    await mount(<Page />);
    expect(motionHookCalls).not.toHaveBeenCalled();
    cleanup();
    // @ts-expect-error simulate a browser with no Permissions API
    delete navigator.permissions;
    await mount(<Page />);
    expect(motionHookCalls).not.toHaveBeenCalled();
  });

  it("moving: every form goes inert and a banner says why; reading is not blocked", async () => {
    setPermission("granted");
    motionHolder.state = "moving";
    await mount(<Page />);
    expect(screen.getByRole("form", { name: "Expense" }).hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("forms and editing are locked");
    expect(screen.getByRole("status").textContent).toContain("Reading is still on");
  });

  it("a form that appears while moving (a new page, a popup) is locked too", async () => {
    setPermission("granted");
    motionHolder.state = "moving";
    const { rerender } = await mount(<Page />);
    rerender(<Page extra />);
    await act(async () => {});
    expect(screen.getByRole("form", { name: "Late form" }).hasAttribute("inert")).toBe(true);
  });

  it("stopped: forms work and the banner is gone", async () => {
    setPermission("granted");
    await mount(<Page />);
    expect(screen.getByRole("form", { name: "Expense" }).hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("unknown speed does not lock the whole app (it can't ask 'are you parked?' - the HUD and Drive do)", async () => {
    setPermission("granted");
    motionHolder.state = "unknown";
    await mount(<Page />);
    expect(screen.getByRole("form", { name: "Expense" }).hasAttribute("inert")).toBe(false);
  });

  it("setFormsInert only restores forms it locked itself", () => {
    const root = document.createElement("div");
    root.innerHTML = `<form id="a"></form><form id="b" inert></form>`;
    setFormsInert(root, true);
    setFormsInert(root, false);
    expect(root.querySelector("#a")!.hasAttribute("inert")).toBe(false);
    expect(root.querySelector("#b")!.hasAttribute("inert")).toBe(true); // was inert before; not ours to undo
  });

  // SAF-1 (audit Wave 4): editable controls that are NOT inside a <form> (paper-log
  // segment editor, day-edit panel, memory editing, photo pickers) are locked too.
  it("locks editable controls outside any form, leaves exempt regions (the AI kill switches) alone, and restores exactly what it locked", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <form id="f"><input id="in-form" /></form>
      <input id="loose-input" />
      <select id="loose-select"></select>
      <textarea id="loose-text"></textarea>
      <input id="file" type="file" />
      <section data-motion-exempt><input id="kill-switch" type="checkbox" /></section>
      <div inert><input id="already" /></div>`;
    setFormsInert(root, true);
    const locked = (id: string) => root.querySelector(`#${id}`)!.getAttribute("data-motion-locked") === "true";
    expect(locked("f")).toBe(true); // the form itself
    expect(["loose-input", "loose-select", "loose-text", "file"].every(locked)).toBe(true);
    expect(root.querySelector("#kill-switch")!.hasAttribute("inert")).toBe(false); // exempt
    expect(locked("already")).toBe(false); // inside something already inert: not ours
    setFormsInert(root, false);
    expect(root.querySelectorAll('[data-motion-locked="true"]').length).toBe(0);
    expect(root.querySelector("#loose-input")!.hasAttribute("inert")).toBe(false);
    expect(root.querySelector("div[inert]")).toBeTruthy(); // the pre-existing inert stays
  });

  it("while moving, a loose input on the page is inert and comes back when he stops", async () => {
    setPermission("granted");
    motionHolder.state = "moving";
    const view = await mount(
      <div>
        <MotionLock />
        <main id="main-content">
          <input aria-label="Loose editor" />
        </main>
      </div>,
    );
    expect(screen.getByLabelText("Loose editor").hasAttribute("inert")).toBe(true);
    motionHolder.state = "stopped";
    view.rerender(
      <div>
        <MotionLock />
        <main id="main-content">
          <input aria-label="Loose editor" />
        </main>
      </div>,
    );
    await act(async () => {});
    expect(screen.getByLabelText("Loose editor").hasAttribute("inert")).toBe(false);
  });
});
