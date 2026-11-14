// @vitest-environment jsdom
// Reliability Unit B (design B.5): the HOS settings section labels
// the shipped defaults as PROVISIONAL - never as anyone else's rules
// - and frames the values as the driver's own choice, picked by him
// in the app. These words are the honesty mechanism of the whole unit
// (the cycle is his setting, never a carrier fact - owner order
// 2026-11-14), so they are pinned by test.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    getHosSettings: vi.fn().mockResolvedValue({
      hos_cycle: "70/8",
      hos_period_anchor: "00:00",
      hos_restart_enabled: true,
      hos_carrier_timezone: "America/New_York",
    }),
    updateHosSettings: vi.fn(),
  },
  ApiClientError: class ApiClientError extends Error {},
}));

import HosCarrierSettings from "@/components/settings/HosCarrierSettings";

describe("HosCarrierSettings", () => {
  it("shows the provisional defaults labeled as provisional, driver-picked framing intact", async () => {
    render(<HosCarrierSettings />);

    expect(await screen.findByText(/You pick these yourself/)).toBeTruthy();
    // The explainer AND the "still the provisional defaults" status
    // line both carry the phrase - at least one must render.
    expect(screen.getAllByText(/provisional defaults/).length).toBeGreaterThan(0);
    expect(screen.getByText(/not anyone else's rules/i)).toBeTruthy();
    expect(screen.getByText(/still the provisional defaults/)).toBeTruthy();
    // The old carrier-sourced framing is gone from the section (the
    // one remaining "carrier's" is the explicit contrast in "not your
    // carrier's" - the sentence that says the settings are his).
    expect(document.body.textContent).not.toContain("Carrier-specified");
    expect(document.body.textContent).not.toContain("carrier rules");

    const cycle = screen.getByLabelText("Cycle") as HTMLSelectElement;
    expect(cycle.value).toBe("70/8");
    const anchor = screen.getByLabelText(/Period start time/) as HTMLInputElement;
    expect(anchor.value).toBe("00:00");
    const tz = screen.getByLabelText("Timezone for the period start") as HTMLSelectElement;
    expect(tz.value).toBe("America/New_York");
  });
});
