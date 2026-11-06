// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);
const deviceTokens = vi.fn();
const createDeviceToken = vi.fn();
const revokeDeviceToken = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiClient: { deviceTokens: () => deviceTokens(), createDeviceToken: (l: string) => createDeviceToken(l), revokeDeviceToken: (id: string) => revokeDeviceToken(id) },
  ApiClientError: class extends Error {},
}));
import BackgroundTrackingSettings from "@/components/settings/BackgroundTrackingSettings";

describe("BackgroundTrackingSettings", () => {
  it("shows a new key ONCE, then only the device (never the secret) in the list", async () => {
    deviceTokens.mockResolvedValue({ data: [] });
    createDeviceToken.mockResolvedValue({ data: { id: "d1", label: "My Android", created_at: "x", token: "tdv_SECRET_VALUE_1234567890" } });
    render(<BackgroundTrackingSettings />);
    await act(async () => {});
    expect(screen.getByText(/No phone is set up/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name this phone"), { target: { value: "My Android" } });
    deviceTokens.mockResolvedValue({ data: [{ id: "d1", label: "My Android", created_at: "x", last_used_at: null }] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a key for this phone" }));
    });
    expect((screen.getByLabelText("Device key") as HTMLInputElement).value).toBe("tdv_SECRET_VALUE_1234567890");
    expect(document.body.textContent).toContain("shown once");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Done/ }));
    });
    expect(screen.queryByLabelText("Device key")).toBeNull();
    expect(document.body.textContent).not.toContain("tdv_SECRET");
    expect(screen.getByText("My Android")).toBeTruthy();
    expect(document.body.textContent).toContain("never used");
  });

  it("revokes a device", async () => {
    deviceTokens.mockResolvedValue({ data: [{ id: "d1", label: "My Android", created_at: "x", last_used_at: new Date().toISOString() }] });
    revokeDeviceToken.mockResolvedValue({ data: { revoked: true } });
    render(<BackgroundTrackingSettings />);
    await act(async () => {});
    expect(document.body.textContent).toContain("reporting just now");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke My Android" }));
    });
    expect(revokeDeviceToken).toHaveBeenCalledWith("d1");
  });
});
