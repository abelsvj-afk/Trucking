import { describe, expect, it } from "vitest";
import { BOTTOM_TABS, resolveActiveTab } from "@/lib/nav-config";

describe("BOTTOM_TABS (parked decision (a) default)", () => {
  it("is the audit's recommended six tabs, in order", () => {
    expect(BOTTOM_TABS.map((t) => [t.href, t.label])).toEqual([
      ["/", "Home"],
      ["/loads", "Loads"],
      ["/smart-path", "Smart Path"],
      ["/money", "Money"],
      ["/more/assistant", "Assistant"],
      ["/more", "More"],
    ]);
  });

  it("gives every tab a Lucide icon component", () => {
    for (const tab of BOTTOM_TABS) {
      expect(typeof tab.Icon).toBe("object");
    }
  });
});

describe("resolveActiveTab", () => {
  const labelFor = (pathname: string | null | undefined) =>
    resolveActiveTab(pathname)?.label ?? null;

  it("lights Home only on the exact root", () => {
    expect(labelFor("/")).toBe("Home");
  });

  it("prefix-matches section roots and their children", () => {
    expect(labelFor("/loads")).toBe("Loads");
    expect(labelFor("/loads/abc-123")).toBe("Loads");
    expect(labelFor("/money")).toBe("Money");
    expect(labelFor("/money/truck-fund")).toBe("Money");
    expect(labelFor("/smart-path")).toBe("Smart Path");
  });

  it("longest prefix wins: /more/assistant lights Assistant, not More", () => {
    expect(labelFor("/more/assistant")).toBe("Assistant");
  });

  it("lights More for the rest of the More hub", () => {
    expect(labelFor("/more")).toBe("More");
    expect(labelFor("/more/settings")).toBe("More");
    expect(labelFor("/more/research")).toBe("More");
  });

  it("lights Smart Path on the Drive surface", () => {
    expect(labelFor("/smart-path/drive")).toBe("Smart Path");
  });

  it("returns null for paths no tab owns (Fleet lives behind the More hub)", () => {
    expect(labelFor("/fleet")).toBeNull();
    expect(labelFor("/fleet/trucks")).toBeNull();
    expect(labelFor("/login")).toBeNull();
  });

  it("does not match on a partial segment", () => {
    expect(labelFor("/loads-archive")).toBeNull();
    expect(labelFor("/moneyx")).toBeNull();
  });

  it("returns null for an empty pathname", () => {
    expect(labelFor(null)).toBeNull();
    expect(labelFor(undefined)).toBeNull();
    expect(labelFor("")).toBeNull();
  });
});
