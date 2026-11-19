// @vitest-environment jsdom
// Owner 2026-11-17: "there's nowhere to find a download in the app". The Tracker download must stay findable:
// its own page under More, with the download button, and a More row that says what it is.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { act, cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);
vi.mock("@/lib/api-client", () => ({
  apiClient: { deviceTokens: async () => ({ data: [] }), createDeviceToken: vi.fn(), revokeDeviceToken: vi.fn() },
  ApiClientError: class extends Error {},
}));
vi.mock("@/lib/use-page-title", () => ({ usePageTitle: () => undefined }));

import TrackerPage from "@/app/(app)/more/tracker/page";

describe("the Tracker download is easy to find", () => {
  it("More lists 'Tracker app (download)' pointing at its own page", () => {
    const more = readFileSync("src/app/(app)/more/page.tsx", "utf8");
    expect(more).toContain('{ href: "/more/tracker", label: "Tracker app (download)"');
  });

  it("the page has the download button for the current version, the setup steps, and the keys", async () => {
    render(<TrackerPage />);
    await act(async () => {});
    const button = screen.getByRole("button", { name: /Download the Tracker \(Android, version 1\.2\.0\)/ }) as HTMLAnchorElement;
    expect(button.getAttribute("href")).toBe("/downloads/trucking-os-tracker-1.2.0.apk");
    expect(document.body.textContent).toContain("Uninstall the old one first");
    expect(document.body.textContent).toContain("Start tracking");
    expect(screen.getByRole("region", { name: "Background tracking" })).toBeTruthy();
  });
});
