// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    listResearchBriefings: vi.fn(),
    getResearchBriefing: vi.fn(),
    markResearchBriefingRead: vi.fn(),
    dismissResearchBriefing: vi.fn(),
    researchNow: vi.fn(),
  },
  ApiClientError: class MockApiClientError extends Error {
    code = "TEST";
    status = 500;
  },
}));

import { apiClient } from "@/lib/api-client";
import ResearchPage from "@/app/(app)/more/research/page";
import type { ResearchBriefing, ResearchPageData } from "@/types/entities";

const briefing: ResearchBriefing = {
  id: "33333333-3333-4333-8333-333333333333",
  company_id: "c1",
  run_id: null,
  topic: "fuel",
  title: "Diesel slide briefing",
  headline: "Diesel fell again this week",
  findings: [
    { claim: "Diesel fell 4 cents", source_title: "EIA weekly report", source_url: "https://pub.example/diesel" },
    { claim: "A rule was proposed", source_title: "FMCSA notice", source_url: "https://gov.example/rule" },
  ],
  what_changed: "Prices",
  counter_move: "Fuel midweek",
  takeaway: "Watch the Southeast",
  unverified: [],
  sources: [],
  confidence: "high",
  telegram_notified_at: null,
  read_at: "2026-11-01T00:00:00Z",
  dismissed_at: null,
  created_at: "2026-11-07T12:00:00Z",
  delivery_class: "routine",
  delivery_held_until: null,
};

const pageData: ResearchPageData = {
  data: [briefing],
  unread_count: 0,
  runs: [],
  watchers: [],
  usage: { runs_today: 0, runs_this_month: 0, max_runs_per_day: 2, max_runs_per_month: 10 },
  runner: null,
  signals: [],
  engine_enabled: true,
};

describe("Research page - briefing imagery (owner 2026-11-07)", () => {
  it("renders one server-proxied image per finding, alt text from the cited article's title", async () => {
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(pageData);
    const { container } = render(<ResearchPage />);
    await screen.findByText("Diesel slide briefing");
    const imgs = Array.from(container.querySelectorAll<HTMLImageElement>("img.briefing-finding-img"));
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute("src")).toBe(
      `/api/v1/briefing-image?briefing=${briefing.id}&i=0`,
    );
    expect(imgs[1]!.getAttribute("src")).toBe(
      `/api/v1/briefing-image?briefing=${briefing.id}&i=1`,
    );
    expect(imgs[0]!.getAttribute("alt")).toBe("EIA weekly report");
    expect(imgs[1]!.getAttribute("alt")).toBe("FMCSA notice");
    // the briefing headline renders before any finding image, so
    // imagery never pushes the headline off the first screenful
    const order = Array.from(container.querySelectorAll("strong, img.briefing-finding-img"));
    const headlineIdx = order.findIndex((el) => el.textContent === "Diesel slide briefing");
    const firstImgIdx = order.findIndex((el) => el.tagName === "IMG");
    expect(headlineIdx).toBeGreaterThanOrEqual(0);
    expect(firstImgIdx).toBeGreaterThan(headlineIdx);
  });

  it("a finding whose image fails (article had none) renders cleanly with no image", async () => {
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(pageData);
    const { container } = render(<ResearchPage />);
    await screen.findByText("Diesel slide briefing");
    const imgs = Array.from(container.querySelectorAll<HTMLImageElement>("img.briefing-finding-img"));
    expect(imgs).toHaveLength(2);
    fireEvent.error(imgs[1]!);
    const remaining = Array.from(container.querySelectorAll("img.briefing-finding-img"));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.getAttribute("alt")).toBe("EIA weekly report");
    // the finding's claim and source link are untouched by the failure
    expect(screen.getByText(/A rule was proposed/)).toBeTruthy();
    expect(screen.getByText("FMCSA notice")).toBeTruthy();
  });
});
