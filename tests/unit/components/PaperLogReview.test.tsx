// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";

afterEach(() => cleanup());

vi.mock("@/lib/api-client", () => ({
  apiClient: { paperLogReview: vi.fn(), readPaperLog: vi.fn(), savePaperLog: vi.fn() },
  ApiClientError: class extends Error {},
}));

import { apiClient } from "@/lib/api-client";
import PaperLogReviewPage from "@/app/(app)/fleet/hos/paper/[id]/page";
import type { PaperLogReview } from "@/types/paper-logs";

const h = (n: number) => n * 60;

function review(overrides: Partial<PaperLogReview> = {}): PaperLogReview {
  return {
    document_id: "doc-1",
    file_name: "sheet.jpg",
    photo_url: "https://example.test/sheet.jpg",
    scan_url: null,
    time_zone: "America/New_York",
    read: true,
    log_date: "2026-11-03",
    draft: [
      { status: "off_duty", startMin: 0, endMin: h(6), confidence: 0.99, origin: "clean" },
      { status: "driving", startMin: h(6), endMin: h(10), confidence: 0.6, origin: "low" },
      { status: null, startMin: h(10), endMin: h(11), confidence: null, origin: "missing" },
      { status: "off_duty", startMin: h(11), endMin: h(24), confidence: 0.86, origin: "flagged" },
    ],
    problems: [],
    written_totals: { off_duty: 19, sleeper: null, driving: 4, on_duty: 1 },
    truck_number: "12",
    trailer_number: null,
    remarks: null,
    conflicts: [{ id: "c1", duty_status: "on_duty", started_at: "2026-11-03T14:00:00Z", source: "app" }],
    saved_rows: [],
    ...overrides,
  };
}

async function mount(r: PaperLogReview) {
  vi.mocked(apiClient.paperLogReview).mockResolvedValue({ data: r });
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <PaperLogReviewPage params={Promise.resolve({ id: "doc-1" })} />
      </Suspense>,
    );
  });
  await act(async () => {});
}

const saveButton = () => screen.getByRole("button", { name: /Save 2026-11-03 to my log/ }) as HTMLButtonElement;

beforeEach(() => vi.clearAllMocks());

describe("Paper log review", () => {
  it("shows the photo, says how sure the reader was in words, and blocks saving", async () => {
    await mount(review());
    expect(screen.getByAltText("Your paper log sheet")).toBeTruthy();
    expect(screen.getByText(/Reader wasn't sure/)).toBeTruthy();
    expect(screen.getByText(/Couldn't be read/)).toBeTruthy();
    expect(screen.getByText(/Faint on the sheet/)).toBeTruthy();
    expect(screen.getByText(/Not yet confirmed/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("saves only after every stretch is confirmed AND the replaced entries are acknowledged", async () => {
    await mount(review());
    fireEvent.click(screen.getByRole("button", { name: /Yes, that's right/ }));
    fireEvent.change(screen.getAllByLabelText("Status")[2]!, { target: { value: "on_duty" } });
    expect(saveButton().disabled).toBe(true); // conflicts not acknowledged yet
    fireEvent.click(screen.getByRole("checkbox"));
    expect(saveButton().disabled).toBe(false);

    vi.mocked(apiClient.savePaperLog).mockResolvedValue({ data: { inserted: 4 } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(apiClient.savePaperLog).toHaveBeenCalledWith("doc-1", {
      log_date: "2026-11-03",
      segments: [
        { status: "off_duty", start_min: 0, end_min: h(6) },
        { status: "driving", start_min: h(6), end_min: h(10) },
        { status: "on_duty", start_min: h(10), end_min: h(11) },
        { status: "off_duty", start_min: h(11), end_min: h(24) },
      ],
      replace_ids: ["c1"],
    });
    expect(screen.getByText(/Your log now continues from/)).toBeTruthy();
    expect(screen.getByText(/off duty/)).toBeTruthy();
  });

  it("flags written totals that disagree with the recreated day", async () => {
    await mount(
      review({
        draft: [
          { status: "off_duty", startMin: 0, endMin: h(20), confidence: 0.99, origin: "clean" },
          { status: "driving", startMin: h(20), endMin: h(24), confidence: 0.99, origin: "clean" },
        ],
        written_totals: { off_duty: 19, sleeper: null, driving: 4, on_duty: 1 },
        conflicts: [],
      }),
    );
    expect(screen.getAllByText(/differs/).length).toBeGreaterThan(0);
    expect(saveButton().disabled).toBe(false);
  });

  it("an unread sheet offers a read or entry by hand - a whole missing day, nothing invented", async () => {
    await mount(
      review({
        read: false,
        log_date: null,
        draft: [{ status: null, startMin: 0, endMin: h(24), confidence: null, origin: "missing" }],
        written_totals: null,
        conflicts: [],
      }),
    );
    expect(screen.getByRole("button", { name: "Read the grid" })).toBeTruthy();
    expect(screen.getByText(/date couldn't be read/)).toBeTruthy();
    const save = screen.getByRole("button", { name: /Save this day to my log/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});
