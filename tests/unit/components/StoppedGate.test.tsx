// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import StoppedGate from "@/components/hud/StoppedGate";
import type { MotionState } from "@/lib/vehicle-motion";

afterEach(() => cleanup());

const mount = (motion: MotionState) =>
  render(
    <StoppedGate motion={motion}>
      <p>the form</p>
    </StoppedGate>,
  );

describe("StoppedGate", () => {
  it("stopped: straight through", () => {
    mount("stopped");
    expect(screen.getByText("the form")).toBeTruthy();
  });

  it("moving: blocked outright, with the reason in words", () => {
    mount("moving");
    expect(screen.queryByText("the form")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("You're moving");
  });

  it("unknown: nothing until he says 'I'm parked'", () => {
    mount("unknown");
    expect(screen.queryByText("the form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "I'm parked" }));
    expect(screen.getByText("the form")).toBeTruthy();
  });

  it("an earlier 'I'm parked' does not survive the truck moving: it asks again afterwards", () => {
    const { rerender } = mount("unknown");
    fireEvent.click(screen.getByRole("button", { name: "I'm parked" }));
    expect(screen.getByText("the form")).toBeTruthy();
    rerender(
      <StoppedGate motion="moving">
        <p>the form</p>
      </StoppedGate>,
    );
    expect(screen.queryByText("the form")).toBeNull();
    rerender(
      <StoppedGate motion="unknown">
        <p>the form</p>
      </StoppedGate>,
    );
    expect(screen.queryByText("the form")).toBeNull();
    expect(screen.getByRole("button", { name: "I'm parked" })).toBeTruthy();
  });
});
