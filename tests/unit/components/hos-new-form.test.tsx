// @vitest-environment jsdom
// Reliability Unit B acceptance B.4.2 at the form level: the duty-log
// form's Started-at default is the LOCAL wall-clock reading of "now",
// composed from local components - the property F-011 violated when
// the default was a UTC slice (at 8 PM Eastern it showed the next
// day's midnight). The zone-distinguishing proof (America/New_York,
// where local != UTC) lives in tests/unit/lib/time.test.ts, which runs
// the same helper in a TZ-set child process; this test pins that the
// FORM's default is built from local components, in whatever zone the
// process runs.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    list: vi.fn().mockResolvedValue({ data: [] }),
    create: vi.fn(),
  },
  ApiClientError: class ApiClientError extends Error {},
}));

vi.mock("@/lib/use-submission-id", () => ({
  useSubmissionId: () => "test-submission-id",
}));

import NewDutyLogPage from "@/app/(app)/fleet/hos/new/page";

function localComponents(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe("New duty log form - Started at default (B.4.2, F-011)", () => {
  it("pre-fills the current LOCAL wall time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T18:30:00Z"));
    try {
      render(<NewDutyLogPage />);
      const input = screen.getByLabelText("Started at") as HTMLInputElement;
      expect(input.type).toBe("datetime-local");
      expect(input.value).toBe(localComponents(new Date("2026-06-15T18:30:00Z")));
      expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    } finally {
      vi.useRealTimers();
    }
  });
});
