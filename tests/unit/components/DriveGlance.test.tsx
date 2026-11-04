// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DriveGlance from "@/components/drive/DriveGlance";

afterEach(() => cleanup());

const base = {
  clocks: <div data-testid="clocks">clocks</div>,
  map: <div data-testid="map">map</div>,
  nextStop: { name: "Pilot, Dothan AL", milesAway: 42.3, badge: "Fuel" },
  upcoming: { arrow: "↱", instruction: "Turn right onto US-231", milesAway: 1.2 },
  driveLeftText: "Drive left 6h 10m",
  gpsBanner: null,
  speedUnknown: false,
  onSkip: () => {},
  onParked: () => {},
};

describe("DriveGlance - the moving surface", () => {
  it("keeps the live map visible while moving", () => {
    render(<DriveGlance {...base} />);
    expect(screen.getByTestId("map")).toBeTruthy();
    expect(screen.getByText("Pilot, Dothan AL")).toBeTruthy();
    expect(screen.getByText(/Turn right onto US-231/)).toBeTruthy();
  });

  it("has no links out and exactly two controls: Skip stop and I'm parked (no 'Talk to Abel')", () => {
    render(<DriveGlance {...base} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByText(/Talk to Abel/)).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Skip stop", "I'm parked"]);
  });

  it("I'm parked is the way back; Skip stop works", () => {
    const onParked = vi.fn();
    const onSkip = vi.fn();
    render(<DriveGlance {...base} onParked={onParked} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: "I'm parked" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip stop" }));
    expect(onParked).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("with every stop done it still renders (never a blank screen) and offers only I'm parked", () => {
    render(<DriveGlance {...base} nextStop={null} upcoming={null} />);
    expect(screen.getByText(/every stop is done/)).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["I'm parked"]);
  });

  it("says in words when it is treating the truck as moving because there is no GPS speed", () => {
    render(<DriveGlance {...base} speedUnknown />);
    expect(screen.getByText(/No GPS speed — treating the truck as moving/)).toBeTruthy();
  });
});
