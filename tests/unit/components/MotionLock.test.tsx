// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  // @ts-expect-error test cleanup
  delete navigator.permissions;
});

const motionHolder: { state: "moving" | "stopped" | "unknown"; speed: number | null; duty: string | null } = { state: "stopped", speed: 40, duty: "driving" };
const motionHookCalls = vi.fn();
const createCalls: unknown[] = [];
vi.mock("@/lib/use-vehicle-motion", () => ({
  useVehicleMotionDetail: () => {
    motionHookCalls();
    return { state: motionHolder.state, position: null, speedMph: motionHolder.speed };
  },
}));
vi.mock("@/lib/use-hos-window", () => ({
  useHosWindow: () => ({
    state: motionHolder.duty === "loading"
      ? { status: "loading" }
      : { status: "loaded", data: motionHolder.duty ? [{ duty_status: motionHolder.duty, started_at: "2026-11-05T10:00:00Z" }] : [], hos: {} },
    refresh: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock("@/lib/api-client", () => ({
  apiClient: { create: vi.fn(async (r: string, b: unknown) => (createCalls.push({ r, b }), {})) },
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
  motionHolder.speed = 40;
  motionHolder.duty = "driving"; // existing tests assume a Driving log (today's lock)
  motionHookCalls.mockClear();
  createCalls.length = 0;
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

  // ---- duty-aware lock (owner request 2026-11-05) -----------------------------
  describe("duty-aware: every status x motion x speed", () => {
    const run = async (duty: string | null, state: "moving" | "stopped" | "unknown", speed: number | null) => {
      setPermission("granted");
      motionHolder.duty = duty;
      motionHolder.state = state;
      motionHolder.speed = speed;
      await mount(<Page />);
      return screen.getByRole("form", { name: "Expense" }).hasAttribute("inert");
    };

    it("Driving + moving: locked (today's behavior)", async () => {
      expect(await run("driving", "moving", 5)).toBe(true);
      cleanup();
      expect(await run("driving", "moving", 60)).toBe(true);
    });

    it("no status, unknown status or a not-yet-loaded window + moving: locked (nothing is assumed)", async () => {
      expect(await run(null, "moving", 5)).toBe(true);
      cleanup();
      expect(await run("loading", "moving", 5)).toBe(true);
    });

    for (const duty of ["on_duty", "off_duty", "sleeper"] as const) {
      it(`${duty} + moving SLOWLY: no hard lock - forms stay open and the app asks`, async () => {
        expect(await run(duty, "moving", 4)).toBe(false);
        expect(screen.getByRole("alert").textContent).toMatch(/truck is moving, but your status says/i);
        expect(screen.getByText("Switch to Driving")).toBeTruthy();
      });

      it(`${duty} + moving at road speed or with no speed reading: still locked (a mislogged status can't unlock a moving truck)`, async () => {
        expect(await run(duty, "moving", 30)).toBe(true);
        cleanup();
        expect(await run(duty, "moving", null)).toBe(true);
      });

      it(`${duty} + stopped or unknown motion: nothing`, async () => {
        expect(await run(duty, "stopped", 0)).toBe(false);
        expect(screen.queryByRole("alert")).toBeNull();
        cleanup();
        expect(await run(duty, "unknown", null)).toBe(false);
      });
    }

    it("'Switch to Driving' logs Driving now with one tap", async () => {
      await run("on_duty", "moving", 3);
      await act(async () => {
        screen.getByText("Switch to Driving").click();
      });
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toMatchObject({ r: "duty-logs", b: { duty_status: "driving" } });
    });

    it("'Not now' leaves forms open under a slim persistent banner", async () => {
      await run("off_duty", "moving", 3);
      await act(async () => {
        screen.getByText("Not now").click();
      });
      expect(screen.getByRole("form", { name: "Expense" }).hasAttribute("inert")).toBe(false);
      expect(screen.getByRole("status").textContent).toMatch(/Truck is moving; your log says Off duty/);
      expect(screen.queryByText("Switch to Driving")).toBeNull();
    });
  });
});
