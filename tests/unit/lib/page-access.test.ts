// Owner-only pages (docs/design/business-credit.md §1): the flag is
// data, the check is central, and the fallback keeps the gate
// identical when the table is missing.

import { describe, expect, it } from "vitest";
import {
  FALLBACK_PAGE_ACCESS_RULES,
  canAccessRoute,
  isOwnerRole,
  isRouteOwnerOnly,
  loadPageAccessRules,
  type PageAccessRule,
} from "@/lib/page-access";

const rules: PageAccessRule[] = [
  { route_prefix: "/more/business-credit", owner_only: true },
  { route_prefix: "/more", owner_only: false },
];

describe("page access", () => {
  it("only the owner role is the owner", () => {
    expect(isOwnerRole("owner")).toBe(true);
    expect(isOwnerRole("driver")).toBe(false);
    expect(isOwnerRole(null)).toBe(false);
    expect(isOwnerRole(undefined)).toBe(false);
  });

  it("prefix-matches the flagged route, longest prefix wins", () => {
    expect(isRouteOwnerOnly(rules, "/more/business-credit")).toBe(true);
    expect(isRouteOwnerOnly(rules, "/more/business-credit/anything")).toBe(true);
    expect(isRouteOwnerOnly(rules, "/more/research")).toBe(false);
    expect(isRouteOwnerOnly(rules, "/home")).toBe(false);
    // A sibling path is NOT under the flagged prefix (segment match).
    expect(isRouteOwnerOnly(rules, "/more/business-creditx")).toBe(false);
  });

  it("owner passes everywhere; non-owner is refused ONLY on flagged routes", () => {
    expect(canAccessRoute(rules, "owner", "/more/business-credit")).toBe(true);
    expect(canAccessRoute(rules, "driver", "/more/business-credit")).toBe(false);
    expect(canAccessRoute(rules, null, "/more/business-credit")).toBe(false);
    expect(canAccessRoute(rules, "driver", "/more/research")).toBe(true);
    expect(canAccessRoute(rules, "driver", "/home")).toBe(true);
  });

  it("the compiled fallback flags business-credit owner-only", () => {
    expect(canAccessRoute(FALLBACK_PAGE_ACCESS_RULES, "driver", "/more/business-credit")).toBe(false);
    expect(canAccessRoute(FALLBACK_PAGE_ACCESS_RULES, "owner", "/more/business-credit")).toBe(true);
  });

  it("loadPageAccessRules falls back when the table errors or is empty", async () => {
    const errClient = {
      from: () => ({
        select: async () => ({ data: null, error: { message: "missing table" } }),
      }),
    } as never;
    expect(await loadPageAccessRules(errClient)).toEqual(FALLBACK_PAGE_ACCESS_RULES);
    const emptyClient = {
      from: () => ({
        select: async () => ({ data: [], error: null }),
      }),
    } as never;
    expect(await loadPageAccessRules(emptyClient)).toEqual(FALLBACK_PAGE_ACCESS_RULES);
  });
});
