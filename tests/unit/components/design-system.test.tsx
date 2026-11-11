// @vitest-environment jsdom
// Smoke tests for the Phase 1 shared design-system components
// (spec §2.6): presentational, typed, no behavior beyond their props.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import Card from "@/components/Card";
import ListRow from "@/components/ListRow";
import HubRow from "@/components/HubRow";
import Field from "@/components/Field";
import SegmentedStatus from "@/components/SegmentedStatus";
import QuickAction from "@/components/QuickAction";
import ReasonField, { REASON_CHIPS } from "@/components/ReasonField";
import NewsCard, { BrandedTile } from "@/components/NewsCard";

afterEach(() => cleanup());

describe("design-system components", () => {
  it("Card renders children on the ds-card surface", () => {
    render(<Card>Pay summary</Card>);
    expect(screen.getByText("Pay summary").className).toContain("ds-card");
  });

  it("ListRow renders dot, two lines, and the trailing action", () => {
    render(<ListRow title="Driving" sub="8:05 AM – now" action={<a href="#fix">Fix</a>} />);
    expect(screen.getByText("Driving")).toBeTruthy();
    expect(screen.getByText("8:05 AM – now")).toBeTruthy();
    expect(screen.getByText("Fix")).toBeTruthy();
  });

  it("HubRow links label + description to the hub target", () => {
    render(<HubRow href="/fleet/hos" label="Day log" desc="Your duty clocks." />);
    const link = screen.getByRole("link", { name: /Day log/ });
    expect(link.getAttribute("href")).toBe("/fleet/hos");
    expect(screen.getByText("Your duty clocks.")).toBeTruthy();
  });

  it("Field shows its label and a danger error under the input", () => {
    render(
      <Field label="Started at" htmlFor="f1" error="Enter a start time">
        <input id="f1" />
      </Field>,
    );
    expect(screen.getByText("Started at")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Enter a start time");
  });

  it("SegmentedStatus marks the pressed option and reports changes", () => {
    const onChange = vi.fn();
    render(
      <SegmentedStatus
        ariaLabel="Duty status"
        options={[
          { value: "off", label: "Off duty" },
          { value: "driving", label: "Driving" },
        ]}
        value="driving"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("button", { name: "Driving" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Off duty" }));
    expect(onChange).toHaveBeenCalledWith("off");
  });

  it("QuickAction is a labelled link with its icon", () => {
    render(<QuickAction href="/money/expenses/new" icon="+" label="Add expense" />);
    expect(screen.getByRole("link", { name: /Add expense/ }).getAttribute("href")).toBe(
      "/money/expenses/new",
    );
  });

  it("ReasonField: chips fill the reason and validity follows the text", () => {
    function Harness() {
      const [state, setState] = useState({ value: "", valid: false });
      return (
        <div>
          <ReasonField
            value={state.value}
            onChange={(value, valid) => setState({ value, valid })}
          />
          <p>{state.valid ? "valid" : "invalid"}</p>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByText("invalid")).toBeTruthy();
    for (const chip of REASON_CHIPS) expect(screen.getByRole("button", { name: chip })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wrong time" }));
    expect(screen.getByText("valid")).toBeTruthy();
    expect((screen.getByLabelText(/Why are you fixing this/) as HTMLInputElement).value).toBe(
      "Wrong time",
    );
    fireEvent.change(screen.getByLabelText(/Why are you fixing this/), { target: { value: "  " } });
    expect(screen.getByText("invalid")).toBeTruthy();
  });

  it("NewsCard renders the story image when there is one", () => {
    render(<NewsCard headline="Diesel eases" meta="Wire · 1h ago" imageSrc="/img.jpg" topic="Fuel" />);
    expect(screen.getByText("Diesel eases")).toBeTruthy();
    expect(document.querySelector(".news-card-media img")?.getAttribute("src")).toBe("/img.jpg");
    expect(screen.queryByText("ROAD TO LEGACY")).toBeNull();
  });

  it("NewsCard falls back to the branded tile when there is no image", () => {
    render(<NewsCard headline="Rule proposed" meta="Federal Register · 2h ago" topic="Regulation" />);
    expect(screen.getByText("RL")).toBeTruthy();
    expect(screen.getByText("ROAD TO LEGACY")).toBeTruthy();
    expect(screen.getByText("Regulation")).toBeTruthy();
  });

  it("BrandedTile carries the monogram, wordmark, and topic", () => {
    render(<BrandedTile topic="Fuel" />);
    expect(screen.getByText("RL")).toBeTruthy();
    expect(screen.getByText("Fuel")).toBeTruthy();
  });
});
