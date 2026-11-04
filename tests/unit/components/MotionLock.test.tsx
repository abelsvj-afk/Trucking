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
});
