// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    // Compact chips like TruckPath: icon + miles; names behind More.
    expect(screen.getByRole("img", { name: "Rest area" })).toBeTruthy();
    expect(screen.getByText("7.8")).toBeTruthy();
    expect(screen.getByText("17.2")).toBeTruthy();
    expect(screen.queryByText("Greenville Rest Area")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    expect(screen.getByText("Greenville Rest Area")).toBeTruthy();
  });

  it("shows the nearest three, the rest behind More, truck stops and low bridges included", () => {
    render(
      <DriveUpcomingList
        maneuver={null}
        pois={[
          { id: "a", kind: "truck_stop", name: "Pilot", milesAway: 3.1 },
          { id: "b", kind: "bridge", name: "Low bridge", milesAway: 5.4 },
          { id: "c", kind: "rest", name: null, milesAway: 9 },
          { id: "d", kind: "fuel", name: null, milesAway: 17 },
        ]}
        remaining={null}
      />,
    );
    expect(screen.getByRole("img", { name: "Truck stop" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Low bridge" })).toBeTruthy();
    expect(screen.queryByText("17.0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    expect(screen.getByText("17.0")).toBeTruthy();
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
          timeZone: "America/Chicago",
        }}
      />,
    );
    expect(screen.getByText(/146\.4 mi/)).toBeTruthy();
    expect(screen.getByText(/2h 34m/)).toBeTruthy();
    expect(screen.getByText(/Arrive about 3:57 PM CT/)).toBeTruthy();
  });

  it("never labels the arrival UTC", () => {
    render(
      <DriveUpcomingList maneuver={null} pois={[]} remaining={{ milesLeft: 1, minutesLeft: 20, etaAt: new Date("2026-11-18T16:57:00Z"), timeZone: "UTC" }} />,
    );
    expect(document.body.textContent).not.toMatch(/UTC|GMT/);
  });

  it("time left ticks in seconds under 10 minutes", () => {
    render(<DriveUpcomingList maneuver={null} pois={[]} remaining={{ milesLeft: 7.8, minutesLeft: 8.34, etaAt: null }} />);
    expect(screen.getByText(/8m 20s/)).toBeTruthy();
  });

  it("shows the speed box (limit + MPH, orange when over) and the where-am-I pill (2026-11-19)", () => {
    render(
      <DriveUpcomingList
        maneuver={null}
        pois={[]}
        remaining={null}
        speed={{ limitMph: 70, speedMph: 74 }}
        where={{ top: "I-10 W · MM245", bottom: "Greenville · FL" }}
      />,
    );
    expect(screen.getByRole("img", { name: "Speed limit 70" })).toBeTruthy();
    const mph = screen.getByLabelText("Your speed 74 miles per hour") as HTMLElement;
    expect(mph.style.color).toBe("rgb(234, 88, 12)");
    expect(screen.getByText("I-10 W · MM245")).toBeTruthy();
    expect(screen.getByText("Greenville · FL")).toBeTruthy();
  });

  it("no known limit: no limit plate, never a guess", () => {
    render(<DriveUpcomingList maneuver={null} pois={[]} remaining={null} speed={{ limitMph: null, speedMph: 55 }} />);
    expect(screen.queryByText("LIMIT")).toBeNull();
    expect(screen.getByText("55")).toBeTruthy();
  });

  it("renders nothing when there is nothing ahead", () => {
    const { container } = render(<DriveUpcomingList maneuver={null} pois={[]} remaining={null} />);
    expect(container.firstChild).toBeNull();
  });
});
