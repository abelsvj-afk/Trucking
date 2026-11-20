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
  GROUP_SEATS,
  GROUP_SEATS_PHASE_0,
  GROUP_SEATS_PHASE_2,
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

  it("gives Maintenance its governing-file scope: HOS none, documents/email draft, maps read, calls gated, signature never", () => {
    expect(toolScopeFor("maintenance", "loads")).toBe("read");
    expect(toolScopeFor("maintenance", "hos")).toBe("none");
    expect(toolScopeFor("maintenance", "money")).toBe("read");
    expect(toolScopeFor("maintenance", "documents")).toBe("draft");
    expect(toolScopeFor("maintenance", "email")).toBe("draft");
    expect(toolScopeFor("maintenance", "maps")).toBe("read");
    expect(toolScopeFor("maintenance", "app-actions")).toBe("draft");
    expect(toolScopeFor("maintenance", "calls")).toBe("gated");
    expect(toolScopeFor("maintenance", "signature")).toBe("never");
    expect(canRead("maintenance", "hos")).toBe(false);
    expect(canDraft("maintenance", "documents")).toBe(true);
    expect(canDraft("maintenance", "email")).toBe(true);
    expect(canDraft("maintenance", "hos")).toBe(false);
    expect(canFlag("maintenance", "loads")).toBe(false);
    expect(visibleToolGroups("maintenance")).not.toContain("hos");
    expect(visibleToolGroups("maintenance")).not.toContain("signature");
    expect(BOT_REGISTRY["maintenance"].status).toBe("live");
  });

  it("seats the whole team in the group", () => {
    expect([...GROUP_SEATS].sort()).toEqual(["abel", "auditor", "billing", "compliance-watchdog", "dispatch-scout", "maintenance", "tracker"].sort());
    expect(GROUP_SEATS).toContain("maintenance");
  });
  it("gives Tracker its governing scope: loads + documents read-write, HOS read, money none, email gated by proposals", () => {
    expect(toolScopeFor("tracker", "loads")).toBe("read-write");
    expect(toolScopeFor("tracker", "documents")).toBe("read-write");
    expect(toolScopeFor("tracker", "hos")).toBe("read");
    expect(toolScopeFor("tracker", "money")).toBe("none");
    expect(toolScopeFor("tracker", "email")).toBe("read-write");
    expect(toolScopeFor("tracker", "maps")).toBe("read");
    expect(toolScopeFor("tracker", "app-actions")).toBe("read-write");
    expect(toolScopeFor("tracker", "calls")).toBe("gated");
    expect(toolScopeFor("tracker", "signature")).toBe("never");
    expect(canRead("tracker", "money")).toBe(false);
    expect(canDraft("tracker", "loads")).toBe(true);
    expect(canDraft("tracker", "documents")).toBe(true);
    expect(visibleToolGroups("tracker")).not.toContain("money");
    expect(visibleToolGroups("tracker")).not.toContain("signature");
  });

  it("seats Abel, Dispatch Scout, Billing, the Auditor, Compliance Watchdog, Tracker, and Maintenance in the group", () => {
    expect([...GROUP_SEATS].sort()).toEqual(["abel", "auditor", "billing", "compliance-watchdog", "dispatch-scout", "maintenance", "tracker"].sort());
    expect([...GROUP_SEATS_PHASE_0].sort()).toEqual([...GROUP_SEATS].sort());
  });

  it("gives Billing its governing scopes — money/documents draft, email gated, no HOS, no maps", () => {
    expect(toolScopeFor("billing", "loads")).toBe("read");
    expect(toolScopeFor("billing", "hos")).toBe("none");
    expect(toolScopeFor("billing", "money")).toBe("draft");
    expect(toolScopeFor("billing", "documents")).toBe("draft");
    expect(toolScopeFor("billing", "email")).toBe("read-write");
    expect(toolScopeFor("billing", "maps")).toBe("none");
    expect(toolScopeFor("billing", "app-actions")).toBe("draft");
    expect(toolScopeFor("billing", "calls")).toBe("gated");
    expect(toolScopeFor("billing", "signature")).toBe("never");
    expect(canRead("billing", "money")).toBe(true);
    expect(canDraft("billing", "money")).toBe(true);
    expect(canRead("billing", "hos")).toBe(false);
    expect(canRead("billing", "maps")).toBe(false);
    expect(visibleToolGroups("billing")).not.toContain("hos");
    expect(visibleToolGroups("billing")).not.toContain("maps");
    expect(visibleToolGroups("billing")).not.toContain("signature");
  });

  it("gives Compliance Watchdog its governing scope: read loads/HOS, file documents, draft reminders, no maps, no money, no calls", () => {
    expect(toolScopeFor("compliance-watchdog", "loads")).toBe("read");
    expect(toolScopeFor("compliance-watchdog", "hos")).toBe("read");
    expect(toolScopeFor("compliance-watchdog", "money")).toBe("none");
    expect(toolScopeFor("compliance-watchdog", "documents")).toBe("read-write");
    expect(toolScopeFor("compliance-watchdog", "email")).toBe("draft");
    expect(toolScopeFor("compliance-watchdog", "maps")).toBe("none");
    expect(toolScopeFor("compliance-watchdog", "app-actions")).toBe("flag");
    expect(toolScopeFor("compliance-watchdog", "calls")).toBe("never");
    expect(toolScopeFor("compliance-watchdog", "signature")).toBe("never");
    expect(canRead("compliance-watchdog", "hos")).toBe(true);
    expect(canDraft("compliance-watchdog", "email")).toBe(true);
    expect(canDraft("compliance-watchdog", "loads")).toBe(false);
    expect(canFlag("compliance-watchdog", "hos")).toBe(true);
    expect(canFlag("compliance-watchdog", "money")).toBe(false);
    expect(visibleToolGroups("compliance-watchdog")).not.toContain("maps");
    expect(visibleToolGroups("compliance-watchdog")).not.toContain("money");
    expect(visibleToolGroups("compliance-watchdog")).not.toContain("calls");
  });

  it("seats Abel, Dispatch Scout, and Compliance Watchdog in the Phase 2 group", () => {
    expect([...GROUP_SEATS_PHASE_2].sort()).toEqual(["abel", "compliance-watchdog", "dispatch-scout"].sort());
    for (const slug of GROUP_SEATS_PHASE_2) expect(GROUP_SEATS).toContain(slug);
  });

  it("seats Tracker in the group (its Phase 2 seat)", () => {
    expect(GROUP_SEATS).toContain("tracker");
  });
});
