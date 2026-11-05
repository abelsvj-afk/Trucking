// @vitest-environment jsdom
// Pay terms are the owner's data: the seeded Steven / 55 cents shows, the
// fields he has not set read "Not set" with a note that nothing is calculated
// from them, and "Terms changed" closes the old row before starting a new one.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: string[] = [];
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    list: vi.fn().mockResolvedValue({
      data: [{ id: "p1", employer_name: "Steven", rate_cents_per_mile: 55, mile_basis: null, worker_type: null, fuel_paid_by: null, effective_from: "2026-10-01", effective_to: null, updated_at: "x" }],
    }),
    update: vi.fn(async (_r: string, id: string, body: Record<string, unknown>) => { calls.push(`update:${id}:${JSON.stringify(body)}`); return {}; }),
    create: vi.fn(async (_r: string, body: Record<string, unknown>) => { calls.push(`create:${JSON.stringify(body)}`); return {}; }),
  },
  ApiClientError: class ApiClientError extends Error {},
}));

import PayTermsSettings from "@/components/settings/PayTermsSettings";

afterEach(() => { cleanup(); calls.length = 0; });

describe("PayTermsSettings", () => {
  it("shows the seeded rate with basis and tax status visibly UNSET", async () => {
    render(<PayTermsSettings />);
    expect(await screen.findByText("Steven")).toBeTruthy();
    expect((screen.getByLabelText(/Pay per mile/) as HTMLInputElement).value).toBe("0.55");
    expect((screen.getByLabelText("Which miles are paid") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("note").textContent).toMatch(/Miles basis is not set, tax status is not set/);
    expect(screen.getByRole("note").textContent).toMatch(/Nothing is guessed/);
  });

  it("'Terms changed' closes the old terms first, then starts new ones in integer cents", async () => {
    render(<PayTermsSettings />);
    await screen.findByText("Steven");
    fireEvent.change(screen.getByLabelText(/Pay per mile/), { target: { value: "0.60" } });
    fireEvent.change(screen.getByLabelText("Which miles are paid"), { target: { value: "loaded" } });
    fireEvent.click(screen.getByText(/Terms changed/));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatch(/^update:p1:\{"effective_to":"\d{4}-\d{2}-\d{2}"\}$/);
    expect(calls[1]).toContain('"rate_cents_per_mile":60');
    expect(calls[1]).toContain('"mile_basis":"loaded"');
    expect(calls[1]).toContain('"worker_type":null');
  });
});
