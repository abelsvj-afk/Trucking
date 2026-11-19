// Calling hook — STUB ONLY. Calling is not live (Telnyx outbound
// setup still open, API key not arrived), so every call request is
// refused with the reason. Nothing can dial by accident.
import { describe, expect, it } from "vitest";
import { CALLING_NOT_LIVE_REASON, requestCall, SHARED_CALLING_NUMBER } from "@/services/bots/calling";

describe("calling stub", () => {
  it("refuses every call request with the not-live reason", () => {
    const result = requestCall({ botSlug: "dispatch-scout", to: "+15551234567", purpose: "negotiate", approvedProposalId: "proposal-1" });
    expect(result).toEqual({ ok: false, reason: CALLING_NOT_LIVE_REASON });
  });

  it("names the one shared number exactly", () => {
    expect(SHARED_CALLING_NUMBER).toBe("+1 320-369-0102");
  });
});
