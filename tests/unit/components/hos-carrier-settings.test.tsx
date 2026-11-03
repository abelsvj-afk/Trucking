// @vitest-environment jsdom
// Reliability Unit B (design B.5): the carrier HOS settings section
// labels the shipped defaults as PROVISIONAL - never as carrier
// facts - and frames the values as carrier-specified. These words are
// the honesty mechanism of the whole unit (the real carrier facts are
// a deferred owner decision), so they are pinned by test.

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
  it("shows the provisional defaults labeled as provisional, carrier-specified framing intact", async () => {
    render(<HosCarrierSettings />);

    expect(await screen.findByText(/Carrier-specified/)).toBeTruthy();
    // The explainer AND the "still the provisional defaults" status
    // line both carry the phrase - at least one must render.
    expect(screen.getAllByText(/provisional defaults/).length).toBeGreaterThan(0);
    expect(screen.getByText(/not verified carrier facts/i)).toBeTruthy();
    expect(screen.getByText(/still the provisional defaults/)).toBeTruthy();

    const cycle = screen.getByLabelText("Cycle") as HTMLSelectElement;
    expect(cycle.value).toBe("70/8");
    const anchor = screen.getByLabelText(/Period start time/) as HTMLInputElement;
    expect(anchor.value).toBe("00:00");
    const tz = screen.getByLabelText("Carrier timezone") as HTMLSelectElement;
    expect(tz.value).toBe("America/New_York");
  });
});
