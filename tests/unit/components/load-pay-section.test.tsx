// @vitest-environment jsdom
// "What this load pays me" on the load page: worked out from his terms, with his own figure on top.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const updates: Array<Record<string, unknown>> = [];
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    list: vi.fn().mockResolvedValue({
      data: [{ id: "p1", employer_name: "Acme", rate_cents_per_mile: 0, percent_of_load_bps: 8500, mile_basis: null, effective_from: "2026-01-01", effective_to: null }],
    }),
    update: vi.fn(async (_r: string, _id: string, body: Record<string, unknown>) => {
      updates.push(body);
      return { ...LOAD, ...body };
    }),
  },
  ApiClientError: class ApiClientError extends Error {},
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import LoadPaySection from "@/components/LoadPaySection";
import type { Load } from "@/types/entities";

const LOAD = {
  id: "L1", origin: "Macon, GA", destination: "Tampa, FL", status: "confirmed", rate_cents: 200000, miles: 500,
  pickup_date: "2026-11-04", delivery_date: "2026-11-05", pay_override_cents: null,
} as unknown as Load;

afterEach(() => { cleanup(); updates.length = 0; });

describe("LoadPaySection", () => {
  it("shows the pay worked out from his percent, and says what it counted", async () => {
    render(<LoadPaySection load={LOAD} onSaved={() => {}} />);
    expect(await screen.findByText("$1,700.00")).toBeTruthy();
    expect(screen.getByText(/85% of the \$2,000.00 load/)).toBeTruthy();
  });

  it("lets him set his own figure for the load, in integer cents", async () => {
    const saved = vi.fn();
    render(<LoadPaySection load={LOAD} onSaved={saved} />);
    fireEvent.click(await screen.findByText("Set my own figure for this load"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "1,250" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({ pay_override_cents: 125000 });
    expect(saved).toHaveBeenCalled();
  });

  it("a figure he set wins and can be cleared back to his terms", async () => {
    render(<LoadPaySection load={{ ...LOAD, pay_override_cents: 125000 }} onSaved={() => {}} />);
    expect(await screen.findByText("$1,250.00")).toBeTruthy();
    expect(screen.getAllByText(/the figure you set/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Use my pay terms instead"));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({ pay_override_cents: null });
  });

  it("refuses text that isn't an amount", async () => {
    render(<LoadPaySection load={LOAD} onSaved={() => {}} />);
    fireEvent.click(await screen.findByText("Set my own figure for this load"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "lots" } });
    fireEvent.click(screen.getByText("Save"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/amount in dollars/);
    expect(updates).toHaveLength(0);
  });
});
