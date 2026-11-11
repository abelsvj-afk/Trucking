// @vitest-environment jsdom
//
// UI/UX Phase 4 pins (spec §2.4):
//  - collapse preference persists: useHomeMapCollapsed reads the
//    stored value on mount and PUTs on toggle (via /api/v1/preferences);
//    a failed read leaves the default (expanded) and still settles.
//  - briefing items get imageSrc from the briefing-image endpoint;
//    a NewsCard whose image errors renders the BrandedTile fallback.
//  - today's-log strip rows deep-link to /fleet/hos?entry=<id>, and
//    an empty day offers the same door.
//  - source pins: Home's quick-action grid holds exactly the five
//    ruled tiles (Start pre-trip first, no Ask Abel); Driver pay's
//    title + pay-terms card render from data (no hardcoded rate);
//    loads/expenses detail Edit opens a Sheet and the /edit routes
//    render the same form components.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import NewsCard from "@/components/NewsCard";
import TodaysLogStrip from "@/components/TodaysLogStrip";
import { useHomeMapCollapsed } from "@/lib/use-preferences";
import { buildBannerItems } from "@/lib/news-banner";
import type { ResearchBriefing } from "@/types/entities";
import type { HosWindowState } from "@/lib/use-hos-window";

const ROOT = join(__dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("collapse preference persistence (useHomeMapCollapsed)", () => {
  it("applies the stored collapsed value once the read settles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ key: "home_map_collapsed", value: { collapsed: true } }),
      })),
    );
    const { result } = renderHook(() => useHomeMapCollapsed());
    // While loading: expanded (the live default), never flash-collapsed.
    expect(result.current.loaded).toBe(false);
    expect(result.current.collapsed).toBe(false);
    await act(async () => {});
    expect(result.current.loaded).toBe(true);
    expect(result.current.collapsed).toBe(true);
  });

  it("toggling PUTs the new value to /api/v1/preferences", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: { method?: string; body?: string; headers?: Record<string, string> }) => ({
        ok: true,
        json: async () => ({ key: "home_map_collapsed", value: null }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useHomeMapCollapsed());
    await act(async () => {});
    act(() => result.current.setCollapsed(true));
    expect(result.current.collapsed).toBe(true);
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put).toBeTruthy();
    expect(put![0]).toBe("/api/v1/preferences");
    expect(JSON.parse(put![1]!.body!)).toEqual({
      key: "home_map_collapsed",
      value: { collapsed: true },
    });
  });

  it("a failed read settles on the expanded default instead of breaking", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { result } = renderHook(() => useHomeMapCollapsed());
    await act(async () => {});
    expect(result.current.loaded).toBe(true);
    expect(result.current.collapsed).toBe(false);
  });
});

describe("news images (Phase 4 wiring)", () => {
  function briefing(partial: Partial<ResearchBriefing> & { id: string }): ResearchBriefing {
    return {
      company_id: "c1",
      run_id: null,
      topic: "fuel",
      title: `Briefing ${partial.id}`,
      headline: "one line",
      findings: [],
      what_changed: "",
      counter_move: "",
      takeaway: "",
      unverified: [],
      sources: [],
      confidence: "high",
      telegram_notified_at: null,
      read_at: "2026-11-01T00:00:00Z",
      dismissed_at: null,
      created_at: new Date().toISOString(),
      delivery_class: "routine",
      delivery_held_until: null,
      ...partial,
    };
  }

  it("a briefing with findings gets imageSrc via /api/v1/briefing-image at the first finding", () => {
    const items = buildBannerItems(
      {
        data: [
          briefing({
            id: "b1",
            findings: [{ claim: "x", source_title: "t", source_url: "https://x.example/a" }],
          }),
        ],
        signals: [],
      },
      new Date(),
    );
    expect(items.find((i) => i.id === "b1")!.imageSrc).toBe("/api/v1/briefing-image?briefing=b1&i=0");
  });

  it("a briefing with no findings honestly gets no image (branded tile instead)", () => {
    const items = buildBannerItems({ data: [briefing({ id: "b2" })], signals: [] }, new Date());
    expect(items.find((i) => i.id === "b2")!.imageSrc).toBeNull();
  });

  it("NewsCard renders the BrandedTile when its image errors", () => {
    const { container } = render(
      <NewsCard headline="A story" imageSrc="/api/v1/briefing-image?briefing=b1&i=0" topic="fuel" />,
    );
    const img = container.querySelector("img")!;
    expect(img).toBeTruthy();
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".branded-tile")!.textContent).toContain("RL");
  });

  it("NewsCard with no image renders the BrandedTile, never a bare text row", () => {
    const { container } = render(<NewsCard headline="A story" imageSrc={null} topic="fuel" />);
    expect(container.querySelector(".branded-tile")).toBeTruthy();
  });
});

describe("today's log strip", () => {
  const windowLoaded = (data: HosWindowState extends { data: infer D } ? D : never): HosWindowState => ({
    status: "loaded",
    data,
    hos: { carrierTimeZone: "America/New_York" } as HosWindowState extends { hos: infer H } ? H : never,
  });

  it("rows link to /fleet/hos?entry=<id>", () => {
    const nowMs = Date.parse("2026-11-10T17:00:00Z"); // noon ET
    const rows = [
      {
        id: "e1",
        driver_id: null,
        load_id: null,
        duty_status: "off_duty" as const,
        started_at: "2026-11-10T05:00:00Z", // midnight ET
        location: null,
        odometer: null,
        notes: null,
        company_id: "c1",
        created_at: "2026-11-10T05:00:00Z",
        updated_at: "2026-11-10T05:00:00Z",
        deleted_at: null,
      },
      {
        id: "e2",
        driver_id: null,
        load_id: null,
        duty_status: "driving" as const,
        started_at: "2026-11-10T13:05:00Z", // 8:05 AM ET
        location: null,
        odometer: null,
        notes: null,
        company_id: "c1",
        created_at: "2026-11-10T13:05:00Z",
        updated_at: "2026-11-10T13:05:00Z",
        deleted_at: null,
      },
    ];
    render(<TodaysLogStrip window={windowLoaded(rows as never)} nowMs={nowMs} />);
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain("/fleet/hos?entry=e1");
    expect(links).toContain("/fleet/hos?entry=e2");
    expect(screen.getByText("Driving")).toBeTruthy();
  });

  it("an empty day offers the Day log door (editor insert mode)", () => {
    render(<TodaysLogStrip window={windowLoaded([] as never)} nowMs={Date.parse("2026-11-10T17:00:00Z")} />);
    expect(screen.getByText(/Nothing logged yet today/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Open Day log to add your first entry/ });
    expect(link.getAttribute("href")).toBe("/fleet/hos");
  });
});

describe("source pins", () => {
  it("Home quick actions: exactly five tiles, Start pre-trip first, no Ask Abel in the grid", () => {
    const home = src("src/app/(app)/page.tsx");
    const grid = home.slice(home.indexOf("quick-actions quick-actions-five"));
    const gridEnd = grid.indexOf("</div>");
    const tiles = grid.slice(0, gridEnd);
    const labels = [...tiles.matchAll(/label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Start pre-trip", "Add expense", "Log fuel", "Add load", "Find a doc"]);
    expect(tiles).not.toContain("Ask Abel");
    expect(tiles).toContain('href="/fleet/pretrip-inspections/new"');
    expect(tiles).toContain('href="/money/expenses/new"');
    expect(tiles).toContain('href="/more/documents"');
  });

  it("Driver pay: title renamed and the pay-terms card renders from data (no hardcoded rate)", () => {
    const pay = src("src/app/(app)/money/pay/page.tsx");
    expect(pay).toContain('usePageTitle("Driver pay")');
    expect(pay).toContain('title="Driver pay"');
    expect(pay).not.toContain('title="Projected pay"');
    const card = src("src/components/PayTermsCard.tsx");
    expect(card).toContain("describeTerms(terms)");
    expect(card).toContain("PayTermsSettings");
    expect(card).not.toMatch(/55|0\.55/);
    const hub = src("src/app/(app)/money/page.tsx");
    expect(hub).toContain('label: "Driver pay"');
    expect(hub).not.toContain("Projected pay");
  });

  it("loads + expenses: detail Edit opens a Sheet hosting the extracted form; /edit routes render the same form", () => {
    const loads = src("src/app/(app)/loads/[id]/page.tsx");
    expect(loads).toContain('from "@/components/edit/LoadEditForm"');
    expect(loads).toContain("<Sheet");
    expect(loads).toContain("setEditOpen(true)");
    const loadsEdit = src("src/app/(app)/loads/[id]/edit/page.tsx");
    expect(loadsEdit).toContain("<LoadEditForm");
    const expenses = src("src/app/(app)/money/expenses/[id]/page.tsx");
    expect(expenses).toContain('from "@/components/edit/ExpenseEditForm"');
    expect(expenses).toContain("<Sheet");
    const expensesEdit = src("src/app/(app)/money/expenses/[id]/edit/page.tsx");
    expect(expensesEdit).toContain("<ExpenseEditForm");
    for (const [detail, edit, form] of [
      ["src/app/(app)/money/fuel-purchases/[id]/page.tsx", "src/app/(app)/money/fuel-purchases/[id]/edit/page.tsx", "FuelPurchaseEditForm"],
      ["src/app/(app)/fleet/trucks/[id]/page.tsx", "src/app/(app)/fleet/trucks/[id]/edit/page.tsx", "TruckEditForm"],
      ["src/app/(app)/fleet/trailers/[id]/page.tsx", "src/app/(app)/fleet/trailers/[id]/edit/page.tsx", "TrailerEditForm"],
      ["src/app/(app)/fleet/drivers/[id]/page.tsx", "src/app/(app)/fleet/drivers/[id]/edit/page.tsx", "DriverEditForm"],
      ["src/app/(app)/more/brokers/[id]/page.tsx", "src/app/(app)/more/brokers/[id]/edit/page.tsx", "BrokerEditForm"],
      ["src/app/(app)/more/customers/[id]/page.tsx", "src/app/(app)/more/customers/[id]/edit/page.tsx", "CustomerEditForm"],
    ] as const) {
      expect(src(detail)).toContain(`@/components/edit/${form}`);
      expect(src(detail)).toContain("<Sheet");
      expect(src(edit)).toContain(`<${form}`);
    }
  });
});
