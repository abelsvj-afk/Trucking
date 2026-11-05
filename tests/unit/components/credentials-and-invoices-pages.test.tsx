// @vitest-environment jsdom
// Audit decision D-1: credentials and invoices now have screens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const calls: string[] = [];
const state: { cred: unknown[]; inv: unknown[] } = { cred: [], inv: [] };
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    list: vi.fn(async (r: string) => ({ data: r === "credentials" ? state.cred : r === "load-invoices" ? state.inv : [{ id: "L1", origin: "A, MO", destination: "B, FL", pickup_date: "2026-11-01" }] })),
    create: vi.fn(async (r: string, b: Record<string, unknown>) => (calls.push(`create:${r}:${JSON.stringify(b)}`), {})),
    update: vi.fn(async (r: string, id: string, b: Record<string, unknown>) => (calls.push(`update:${r}:${id}:${JSON.stringify(b)}`), {})),
    remove: vi.fn(async (r: string, id: string) => (calls.push(`remove:${r}:${id}`), undefined)),
  },
  ApiClientError: class ApiClientError extends Error {},
}));
vi.mock("@/lib/eastern-date", () => ({ todayEastern: () => "2026-11-05" }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import CredentialsPage from "@/app/(app)/more/credentials/page";
import InvoicesPage from "@/app/(app)/money/invoices/page";

beforeEach(() => { calls.length = 0; state.cred = []; state.inv = []; });
afterEach(cleanup);

describe("Credentials page", () => {
  it("shows days left from today (Eastern), flags expired, and adds / renews through the API", async () => {
    state.cred = [
      { id: "c1", kind: "cdl", label: "CDL", expires_on: "2026-11-12", notes: null, updated_at: "x" },
      { id: "c2", kind: "medical_card", label: "Medical card", expires_on: "2026-11-01", notes: null, updated_at: "x" },
    ];
    render(<CredentialsPage />);
    expect(await screen.findByText("7 days left")).toBeTruthy();
    expect(screen.getByText(/EXPIRED 4 days ago/)).toBeTruthy();
    expect(screen.getAllByText(/this stops everything until it's renewed|renew soon/).length).toBe(2);

    const form = within(screen.getByRole("form", { name: "Add credential" }));
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "Insurance" } });
    fireEvent.change(form.getByLabelText("Expires on"), { target: { value: "2027-01-01" } });
    fireEvent.click(form.getByText("Add credential"));
    await waitFor(() => expect(calls.some((c) => c.startsWith("create:credentials"))).toBe(true));
    expect(calls.find((c) => c.startsWith("create:credentials"))).toContain('"expires_on":"2027-01-01"');
  });
});

describe("Invoices page", () => {
  it("ages against today, totals what is outstanding, and 'Mark paid today' records the full amount", async () => {
    state.inv = [
      { id: "i1", load_id: "L1", invoice_date: "2026-09-01", due_date: "2026-10-01", amount_cents: 185000, paid_amount_cents: 0, paid_on: null },
      { id: "i2", load_id: "L1", invoice_date: "2026-10-20", due_date: "2026-11-20", amount_cents: 100000, paid_amount_cents: 100000, paid_on: "2026-11-02" },
    ];
    render(<InvoicesPage />);
    expect(await screen.findByText(/Outstanding \$1,850.00 · 1 late/)).toBeTruthy();
    expect(screen.getByText(/\$1,850.00 · LATE/)).toBeTruthy();
    expect(screen.getByText(/\$1,000.00 · Paid/)).toBeTruthy();
    fireEvent.click(screen.getByText("Mark paid today"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toBe('update:load-invoices:i1:{"paid_amount_cents":185000,"paid_on":"2026-11-05"}');
  });
  it("stores the amount in integer cents", async () => {
    render(<InvoicesPage />);
    await screen.findByText("No invoices yet");
    const form = within(screen.getByRole("form", { name: "Add invoice" }));
    await waitFor(() => expect(form.getByText(/A, MO → B, FL/)).toBeTruthy());
    fireEvent.change(form.getByLabelText("Load"), { target: { value: "L1" } });
    fireEvent.change(form.getByLabelText(/Amount/), { target: { value: "1850.50" } });
    fireEvent.click(form.getByText("Add invoice"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toContain('"amount_cents":185050');
  });
});
