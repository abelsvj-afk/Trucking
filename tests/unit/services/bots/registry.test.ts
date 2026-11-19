// Bot team registry: every bot's tool scope comes from its governing
// file (docs/bots/<slug>/CLAUDE.md). A bot cannot call what it cannot
// see — the gateway offers exactly the visible groups.
import { describe, expect, it } from "vitest";
import {
  BOT_REGISTRY,
  BOT_SLUGS,
  canDraft,
  canFlag,
  canRead,
  GROUP_SEATS_PHASE_0,
  isBotSlug,
  toolScopeFor,
  visibleToolGroups,
} from "@/services/bots/registry";

describe("bot registry", () => {
  it("has exactly the seven governed bots", () => {
    expect([...BOT_SLUGS].sort()).toEqual(
      ["abel", "auditor", "billing", "compliance-watchdog", "dispatch-scout", "maintenance", "tracker"].sort(),
    );
    expect(Object.keys(BOT_REGISTRY).sort()).toEqual([...BOT_SLUGS].sort());
  });

  it("gives the Auditor read-only scope everywhere and no calls, no signature", () => {
    expect(toolScopeFor("auditor", "loads")).toBe("read");
    expect(toolScopeFor("auditor", "money")).toBe("read");
    expect(toolScopeFor("auditor", "app-actions")).toBe("flag");
    expect(toolScopeFor("auditor", "calls")).toBe("never");
    expect(toolScopeFor("auditor", "signature")).toBe("never");
    expect(canDraft("auditor", "loads")).toBe(false);
    expect(canFlag("auditor", "loads")).toBe(true);
  });

  it("gives Dispatch Scout read on loads and draft on app actions only", () => {
    expect(canRead("dispatch-scout", "loads")).toBe(true);
    expect(canDraft("dispatch-scout", "loads")).toBe(false);
    expect(canDraft("dispatch-scout", "app-actions")).toBe(true);
    expect(canRead("dispatch-scout", "money")).toBe(true);
    expect(toolScopeFor("dispatch-scout", "signature")).toBe("never");
  });

  it("hides everything from an unknown bot", () => {
    expect(toolScopeFor("not-a-bot", "loads")).toBe("none");
    expect(canRead("not-a-bot", "loads")).toBe(false);
    expect(visibleToolGroups("not-a-bot")).toEqual([]);
    expect(isBotSlug("not-a-bot")).toBe(false);
  });

  it("never shows calls or signature to bots that must not have them", () => {
    expect(visibleToolGroups("auditor")).not.toContain("calls");
    expect(visibleToolGroups("auditor")).not.toContain("signature");
    expect(visibleToolGroups("compliance-watchdog")).not.toContain("calls");
  });

  it("seats only Abel and Dispatch Scout in the Phase 0 group", () => {
    expect([...GROUP_SEATS_PHASE_0].sort()).toEqual(["abel", "dispatch-scout"].sort());
  });
});
