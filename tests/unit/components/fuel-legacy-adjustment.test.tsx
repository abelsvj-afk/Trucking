// @vitest-environment jsdom
// Reliability Unit C, C.7.6b(d): the legacy-adjustment visibility
// property. For a pre-F-053 row the 00043 migration backfilled
// (100.000 gal x 350c, entered total $500.00 = 50000c: original total
// preserved, computed base 35000c, adjustment exactly 15000c), the
// "Legacy variance (pre-F-053)" reason must render WHEREVER the
// legacy total is shown - the fuel list row AND the fuel detail
// view - not just in the API payload. (Properties (a)-(c) are the
// migration's arithmetic, asserted in the source test against
// 00043's backfill expression itself.)

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

const { LEGACY_PURCHASE } = vi.hoisted(() => ({
  LEGACY_PURCHASE: {
  id: "fp-legacy",
  company_id: "company-1",
  truck_id: "11111111-1111-4111-8111-111111111111",
  location: "Pilot #44",
  gallons: 100,
  price_per_gallon_cents: 350,
  total_cost_cents: 50000,
  adjustment_cents: 15000,
  adjustment_reason: "Legacy variance (pre-F-053)",
    purchased_at: "2026-10-15T12:00:00.000Z",
    created_at: "2026-10-15T12:00:00.000Z",
    updated_at: "2026-10-15T12:00:00.000Z",
    deleted_at: null,
  },
}));

vi.mock("@/lib/use-api-list", () => ({
  useApiList: () => ({
    state: {
      status: "loaded",
      result: { data: [LEGACY_PURCHASE], page: { limit: 50, offset: 0, total: 1 } },
    },
    retry: vi.fn(),
  }),
}));

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue(LEGACY_PURCHASE),
    update: vi.fn(),
    list: vi.fn().mockResolvedValue({ data: [] }),
  },
  ApiClientError: class ApiClientError extends Error {},
}));

vi.mock("@/lib/use-picker-list", () => ({
  usePickerList: () => [],
}));

vi.mock("@/components/RecordLifecycle", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    DeleteRecordButton: () => null,
  };
});

import FuelPurchasesListPage from "@/app/(app)/money/fuel-purchases/page";

describe("legacy fuel adjustment visibility (C.7.6b(d))", () => {
  it("the fuel LIST row renders the adjustment with its legacy reason beside the preserved total", () => {
    render(<FuelPurchasesListPage />);
    expect(screen.getByText(/\$500\.00 — 100 gal/)).toBeTruthy();
    expect(screen.getByText(/incl\. adjustment \$150\.00 — Legacy variance \(pre-F-053\)/)).toBeTruthy();
  });

  // The DETAIL surface is asserted at source level in
  // tests/unit/financial-summary-source.test.ts: this repo's detail
  // pages unwrap route params with React use(), and a plain promise
  // never resolves under this vitest/jsdom setup (verified with a
  // minimal use() component during this unit's build - it stays
  // suspended), which is why the repo has no component tests for any
  // [id] page. The source test pins that the facts section renders
  // the computed base, the adjustment, and its reason from the
  // purchase's own fields.
});
