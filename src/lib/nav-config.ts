// Bottom-tab navigation config — the single switch for the app shell's
// primary navigation (consumed by src/app/(app)/layout.tsx).
//
// PARKED OWNER DECISION (a) — NOT settled, do not treat as final:
// The UI/UX audit (Trucking-UIUX-Audit-2026-11-01.md, finding A-1 /
// Top-10 #1) found the two driving-critical surfaces — Smart Path and
// the Assistant — had NO bottom tab and were buried behind "More".
// The audit's recommended default is implemented here: Smart Path and
// Assistant become permanent bottom tabs, and Fleet drops out of the
// bottom bar (it stays reachable via a "Fleet" row at the top of the
// More hub and via Home quick actions such as "Start pre-trip").
// The owner has NOT ruled on this yet — it ships as the recommended
// default only, pending his decision.
//
// HOW TO REVERT to the Home-pinned (pre-pass) variant: replace the
// BOTTOM_TABS array below with the old five tabs —
//   Home /, Loads /loads, Fleet /fleet, Money /money, More /more
// (Fleet icon: Truck from lucide-react) — and remove the Fleet row
// from the More hub if Fleet regains its own tab. Nothing else in the
// shell hard-codes the tab set; the layout, the icons, and the active
// resolver all read from this file.

import {
  Bot,
  Home,
  MoreHorizontal,
  Package,
  Route,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export interface BottomTab {
  href: string;
  label: string;
  /**
   * Lucide icon component for the tab. Semantic picks:
   * - Home → Home: the house, same read as the hand-rolled glyph it
   *   replaces.
   * - Loads → Package: freight in a box. The old hand-rolled Loads
   *   glyph was a map-pin, which reads as "place", not "freight" —
   *   Package (ClipboardList was the runner-up) says cargo.
   * - Smart Path → Route: a route with waypoints — the map/route
   *   surface itself, not a generic pin.
   * - Money → Wallet: the money hub (spend/fund/summary), broader
   *   than a coin.
   * - Assistant → Bot: Abel the assistant, unmistakably the AI door.
   * - More → MoreHorizontal: the conventional "everything else" dots.
   * Rendered at 22px, strokeWidth 1.75 by the shell layout.
   */
  Icon: LucideIcon;
}

export const BOTTOM_TABS: BottomTab[] = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/loads", label: "Loads", Icon: Package },
  { href: "/smart-path", label: "Smart Path", Icon: Route },
  { href: "/money", label: "Money", Icon: Wallet },
  { href: "/more/assistant", label: "Abel", Icon: Bot },
  { href: "/more", label: "More", Icon: MoreHorizontal },
];

/**
 * Pure longest-prefix-match active-tab resolver.
 *
 * Rules:
 * - "/" matches only the exact root path (every path starts with "/",
 *   so the home tab must never prefix-match).
 * - Any other tab matches when the pathname equals its href or sits
 *   under it at a segment boundary (href + "/").
 * - When several tabs match, the LONGEST href wins — so
 *   /more/assistant lights Assistant, not More, and /smart-path/drive
 *   lights Smart Path.
 * - Returns null when no tab owns the path (e.g. /fleet, which is
 *   reached via the More hub under the parked default above).
 */
export function resolveActiveTab(
  pathname: string | null | undefined,
  tabs: readonly BottomTab[] = BOTTOM_TABS,
): BottomTab | null {
  if (!pathname) return null;
  let best: BottomTab | null = null;
  for (const tab of tabs) {
    const matches =
      tab.href === "/"
        ? pathname === "/"
        : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    if (matches && (best === null || tab.href.length > best.href.length)) {
      best = tab;
    }
  }
  return best;
}
