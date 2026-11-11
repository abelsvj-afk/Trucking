import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Owner-only pages (brief 2026-11-10; docs/design/business-credit.md).
 *
 * The flag lives in DATA (migration 00087's `page_access_rules`), and
 * this module is the ONE place the question "may this role see this
 * route?" is answered. Both consumers call it: the More index (nav
 * hides the entry for non-owners) and the page's API route (the
 * server-side 403 — hiding a link is not enforcement).
 *
 * The owner is `user_profiles.role === 'owner'` (00001's default and
 * getAuthContext's role). A future driver account is simply any other
 * role value — no second mechanism.
 */

export interface PageAccessRule {
  route_prefix: string;
  owner_only: boolean;
}

/**
 * The compiled fallback for the seeded rule. Used when
 * `page_access_rules` doesn't exist yet (00087 not applied) or can't
 * be read: the gate must behave identically, never silently open and
 * never lock the owner out of a page the brief ordered.
 */
export const FALLBACK_PAGE_ACCESS_RULES: PageAccessRule[] = [
  { route_prefix: "/more/business-credit", owner_only: true },
];

export function isOwnerRole(role: string | null | undefined): boolean {
  return role === "owner";
}

/** Longest-prefix match wins; unlisted routes are not owner-only. */
export function isRouteOwnerOnly(
  rules: readonly PageAccessRule[],
  pathname: string,
): boolean {
  let best: PageAccessRule | null = null;
  for (const rule of rules) {
    if (
      pathname === rule.route_prefix ||
      pathname.startsWith(`${rule.route_prefix}/`)
    ) {
      if (!best || rule.route_prefix.length > best.route_prefix.length) {
        best = rule;
      }
    }
  }
  return best?.owner_only ?? false;
}

export function canAccessRoute(
  rules: readonly PageAccessRule[],
  role: string | null | undefined,
  pathname: string,
): boolean {
  if (!isRouteOwnerOnly(rules, pathname)) return true;
  return isOwnerRole(role);
}

/** Reads the rules table; ANY failure falls back to the compiled seed. */
export async function loadPageAccessRules(
  client: SupabaseClient,
): Promise<PageAccessRule[]> {
  try {
    const { data, error } = await client
      .from("page_access_rules")
      .select("route_prefix, owner_only");
    if (error || !data || data.length === 0) return FALLBACK_PAGE_ACCESS_RULES;
    return data.map((r) => ({
      route_prefix: String(r.route_prefix),
      owner_only: r.owner_only === true,
    }));
  } catch {
    return FALLBACK_PAGE_ACCESS_RULES;
  }
}
