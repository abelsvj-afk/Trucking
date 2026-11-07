// @vitest-environment jsdom
// Settings -> Telegram connection: plain-words report and the one repair.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const BROKEN = {
  configured: true, registered: true, host: "example-app.fly.dev", allowedUpdates: ["message"], missing: ["edited_message", "callback_query"],
  pendingCount: 0, lastErrorMessage: null, lastErrorAt: null, secretConfigured: true, healthy: false,
  findings: ["Telegram was told not to send button taps, so inline buttons do nothing.", "Live Location's movement updates arrive as edits."],
};
const FIXED = { ...BROKEN, allowedUpdates: ["message", "edited_message", "callback_query"], missing: [], healthy: true, findings: ["Telegram is delivering your messages, message edits (Live Location) and button taps."] };

const webhook = vi.fn();
const repair = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiClient: { telegramWebhook: () => webhook(), repairTelegramWebhook: () => repair() },
  ApiClientError: class ApiClientError extends Error {},
}));

import TelegramConnectionSettings from "@/components/settings/TelegramConnectionSettings";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("TelegramConnectionSettings", () => {
  it("says what is wrong in plain words and offers the fix", async () => {
    webhook.mockResolvedValue({ data: BROKEN });
    render(<TelegramConnectionSettings />);
    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getByText(/inline buttons do nothing/)).toBeTruthy();
    expect(screen.getByText("Fix the connection")).toBeTruthy();
  });

  it("the repair shows the confirmed result and removes the fix button", async () => {
    webhook.mockResolvedValue({ data: BROKEN });
    repair.mockResolvedValue({ data: { repaired: true, before: BROKEN, after: FIXED, message: "Done - Telegram will now send messages, message edits (Live Location) and button taps." } });
    render(<TelegramConnectionSettings />);
    fireEvent.click(await screen.findByText("Fix the connection"));
    expect(await screen.findByText("Working")).toBeTruthy();
    expect(screen.getByText(/^Done - Telegram will now send/)).toBeTruthy();
    expect(screen.queryByText("Fix the connection")).toBeNull();
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("a healthy connection shows no fix button", async () => {
    webhook.mockResolvedValue({ data: FIXED });
    render(<TelegramConnectionSettings />);
    expect(await screen.findByText("Working")).toBeTruthy();
    expect(screen.queryByText("Fix the connection")).toBeNull();
  });

  it("a failed check shows the error, and a failed repair keeps the button", async () => {
    webhook.mockRejectedValueOnce(new Error("x"));
    render(<TelegramConnectionSettings />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't check Telegram/);
    webhook.mockResolvedValue({ data: BROKEN });
    repair.mockRejectedValue(new Error("x"));
    fireEvent.click(screen.getByText("Check again"));
    fireEvent.click(await screen.findByText("Fix the connection"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Couldn't reach Telegram/));
    expect(screen.getByText("Fix the connection")).toBeTruthy();
  });
});
