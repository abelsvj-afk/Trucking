// @vitest-environment jsdom
// Pay terms are the owner's data: the seeded Acme Freight / 55 cents shows, the
// fields he has not set read "Not set" with a note that nothing is calculated
// from them, and "Terms changed" closes the old row before starting a new one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const calls: string[] = [];
const listMock = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    list: (...a: unknown[]) => listMock(...a),
    _unused: vi.fn().mockResolvedValue({
      data: [{ id: "p1", employer_name: "Acme Freight", rate_cents_per_mile: 55, mile_basis: null, worker_type: null, fuel_paid_by: null, effective_from: "2026-10-01", effective_to: null, updated_at: "x" }],
    }),
    update: vi.fn(async (_r: string, id: string, body: Record<string, unknown>) => { calls.push(`update:${id}:${JSON.stringify(body)}`); return {}; }),
    create: vi.fn(async (_r: string, body: Record<string, unknown>) => { calls.push(`create:${JSON.stringify(body)}`); return {}; }),
  },
  ApiClientError: class ApiClientError extends Error {},
}));

import PayTermsSettings from "@/components/settings/PayTermsSettings";

const ONE = {
  data: [{ id: "p1", employer_name: "Acme Freight", rate_cents_per_mile: 55, mile_basis: null, worker_type: null, fuel_paid_by: null, effective_from: "2026-10-01", effective_to: null, updated_at: "x" }],
};
beforeEach(() => listMock.mockResolvedValue(ONE));
afterEach(() => { cleanup(); calls.length = 0; });

describe("PayTermsSettings", () => {
  it("shows the stored rate with basis and tax status visibly UNSET", async () => {
    render(<PayTermsSettings />);
    await screen.findByText("Acme Freight");
    const form = within(screen.getByRole("form", { name: "Pay terms for Acme Freight" }));
    expect((form.getByLabelText(/Pay per mile/) as HTMLInputElement).value).toBe("0.55");
    expect((form.getByLabelText("Which miles are paid") as HTMLSelectElement).value).toBe("");
    const notes = screen.getAllByRole("note").map((n) => n.textContent ?? "").join(" | ");
    expect(notes).toMatch(/Miles basis is not set/);
    expect(notes).toMatch(/Tax status is not set/);
    expect(notes).toMatch(/Nothing is guessed/);
    // pay week and payday are visibly UNSET too
    expect(notes).toMatch(/Pay week not set/);
    expect(notes).toMatch(/Payday not set/);
  });

  it("'Terms changed' closes the old terms first, then starts new ones in integer cents", async () => {
    render(<PayTermsSettings />);
    await screen.findByText("Acme Freight");
    const form = within(screen.getByRole("form", { name: "Pay terms for Acme Freight" }));
    fireEvent.change(form.getByLabelText(/Pay per mile/), { target: { value: "0.60" } });
    fireEvent.change(form.getByLabelText("Which miles are paid"), { target: { value: "loaded" } });
    fireEvent.click(form.getByText(/Terms changed/));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatch(/^update:p1:\{"effective_to":"\d{4}-\d{2}-\d{2}"\}$/);
    expect(calls[1]).toContain('"rate_cents_per_mile":60');
    expect(calls[1]).toContain('"mile_basis":"loaded"');
    expect(calls[1]).toContain('"worker_type":null');
  });

  it("with nothing stored it asks for the owner's terms and pre-fills nothing", async () => {
    listMock.mockResolvedValue({ data: [] });
    render(<PayTermsSettings />);
    expect(await screen.findByText(/No pay terms entered yet/)).toBeTruthy();
    const form = within(screen.getByRole("form", { name: "Add pay terms" }));
    expect((form.getByLabelText("Employer") as HTMLInputElement).value).toBe("");
    expect((form.getByLabelText(/Pay per mile/) as HTMLInputElement).value).toBe("");
    fireEvent.change(form.getByLabelText("Employer"), { target: { value: "Some Carrier" } });
    fireEvent.change(form.getByLabelText(/Pay per mile/), { target: { value: "0.62" } });
    fireEvent.click(form.getByText("Save pay terms"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toContain('"employer_name":"Some Carrier"');
    expect(calls[0]).toContain('"rate_cents_per_mile":62');
    expect(calls[0]).toContain('"mile_basis":null');
  });

  it("adds percent-only terms with a pay week and payday (no per-mile rate needed)", async () => {
    listMock.mockResolvedValue({ data: [] });
    render(<PayTermsSettings />);
    await screen.findByText(/No pay terms entered yet/);
    const form = within(screen.getByRole("form", { name: "Add pay terms" }));
    fireEvent.change(form.getByLabelText("Employer"), { target: { value: "Some Carrier" } });
    fireEvent.change(form.getByLabelText(/Percent of the load/), { target: { value: "85" } });
    fireEvent.change(form.getByLabelText("Your pay week ends on"), { target: { value: "0" } });
    fireEvent.change(form.getByLabelText("Your statement comes out on"), { target: { value: "4" } });
    fireEvent.change(form.getByLabelText("You get paid on"), { target: { value: "5" } });
    fireEvent.click(form.getByText("Save pay terms"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toContain('"rate_cents_per_mile":0');
    expect(calls[0]).toContain('"percent_of_load_bps":8500');
    expect(calls[0]).toContain('"pay_week_ends_on":0');
    expect(calls[0]).toContain('"statement_weekday":4');
    expect(calls[0]).toContain('"payday_weekday":5');
  });

  it("refuses a save with neither a per-mile rate nor a percent, and a percent over 100", async () => {
    listMock.mockResolvedValue({ data: [] });
    render(<PayTermsSettings />);
    await screen.findByText(/No pay terms entered yet/);
    const form = within(screen.getByRole("form", { name: "Add pay terms" }));
    fireEvent.change(form.getByLabelText("Employer"), { target: { value: "Some Carrier" } });
    fireEvent.click(form.getByText("Save pay terms"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/per-mile rate, a percent of the load, or both/);
    fireEvent.change(form.getByLabelText(/Percent of the load/), { target: { value: "150" } });
    fireEvent.click(form.getByText("Save pay terms"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/0 to 100/));
    expect(calls).toHaveLength(0);
  });

  it("editing existing terms shows the percent and can be corrected in place", async () => {
    listMock.mockResolvedValue({ data: [{ ...ONE.data[0], rate_cents_per_mile: 0, percent_of_load_bps: 8500, payday_weekday: 5 }] });
    render(<PayTermsSettings />);
    await screen.findByText("Acme Freight");
    const form = within(screen.getByRole("form", { name: "Pay terms for Acme Freight" }));
    expect((form.getByLabelText(/Percent of the load/) as HTMLInputElement).value).toBe("85");
    expect((form.getByLabelText("You get paid on") as HTMLSelectElement).value).toBe("5");
    fireEvent.change(form.getByLabelText(/Percent of the load/), { target: { value: "88" } });
    fireEvent.click(form.getByText("Save correction"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatch(/^update:p1:/);
    expect(calls[0]).toContain('"percent_of_load_bps":8800');
  });
});
