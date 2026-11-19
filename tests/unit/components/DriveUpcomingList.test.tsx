// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DriveUpcomingList from "@/components/drive/DriveUpcomingList";

afterEach(() => cleanup());

describe("DriveUpcomingList (the left-hand cards)", () => {
  it("shows the maneuver with miles to one decimal and the exit number", () => {
    render(
      <DriveUpcomingList
        maneuver={{ arrow: "↱", instruction: "Take exit 174 toward US-221.", milesAway: 7.8 }}
        pois={[]}
        remaining={null}
      />,
    );
    expect(screen.getByText(/Take exit 174 toward US-221/)).toBeTruthy();
    expect(screen.getByText("7.8")).toBeTruthy();
    expect(screen.getByText("↗ Exit 174")).toBeTruthy();
  });

  it("shows POIs with live distances to one decimal", () => {
    render(
      <DriveUpcomingList
        maneuver={null}
        pois={[
          { id: "a", kind: "rest", name: "Greenville Rest Area", milesAway: 7.8 },
          { id: "b", kind: "fuel", name: "Love's", milesAway: 17.2 },
        ]}
        remaining={null}
      />,
    );
    expect(screen.getByText("Greenville Rest Area")).toBeTruthy();
    expect(screen.getByText("7.8")).toBeTruthy();
    expect(screen.getByText("17.2")).toBeTruthy();
  });

  it("shows the remaining run with miles, time, and arrival on his clock", () => {
    render(
      <DriveUpcomingList
        maneuver={null}
        pois={[]}
        remaining={{
          milesLeft: 146.4,
          minutesLeft: 154,
          etaAt: new Date("2026-11-18T16:57:00-05:00"),
        }}
      />,
    );
    expect(screen.getByText(/146\.4 mi/)).toBeTruthy();
    expect(screen.getByText(/2h 34m/)).toBeTruthy();
    expect(screen.getByText(/Arrive about 4:57 PM ET/)).toBeTruthy();
  });

  it("renders nothing when there is nothing ahead", () => {
    const { container } = render(<DriveUpcomingList maneuver={null} pois={[]} remaining={null} />);
    expect(container.firstChild).toBeNull();
  });
});
