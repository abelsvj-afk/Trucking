// Bot team registry (Phase 0 baseline; plan docs/bot-team-build-plan.md).
// The 7 bots, their seats, and their tool scopes — derived from each
// bot's governing file (docs/bots/<slug>/CLAUDE.md, PR #95). The
// gateway hides every tool group a bot is not allowed; a bot cannot
// call what it cannot see. This module is pure data + pure checks, so
// it is unit-testable with no database and no network.
//
// Tool groups: loads, hos, money, documents, email, maps,
// app-actions, calls, signature.
// Scope levels:
//   "none"       — the bot never sees this group.
//   "read"       — read only.
//   "draft"      — read + write drafts only (nothing leaves the app).
//   "read-write" — read + write, gated by the propose-only guardrails
//                  (services/bots/guardrails.ts): an execute-class
//                  action still needs an approved proposal.
//   "flag"       — read + post a flag. No other write.
//   "gated"      — calls only under the calling rules (owner-approved
//                  call plan, shared number, logged); "never" for bots
//                  that do not call at all.

export const BOT_SLUGS = [
  "abel",
  "dispatch-scout",
  "tracker",
  "compliance-watchdog",
  "maintenance",
  "billing",
  "auditor",
] as const;

export type BotSlug = (typeof BOT_SLUGS)[number];

export type ToolGroup =
  | "loads"
  | "hos"
  | "money"
  | "documents"
  | "email"
  | "maps"
  | "app-actions"
  | "calls"
  | "signature";

export type ToolScope = "none" | "read" | "draft" | "read-write" | "flag" | "gated" | "never";

export interface BotIdentity {
  slug: BotSlug;
  displayName: string;
  seat: string;
  /** 'live' only for Abel today; the rest are planned until wired. */
  status: "planned" | "live" | "paused";
  toolScope: Record<ToolGroup, ToolScope>;
}

export const BOT_REGISTRY: Record<BotSlug, BotIdentity> = {
  abel: {
    slug: "abel",
    displayName: "Abel",
    seat: "day-to-day assistant",
    status: "live",
    toolScope: {
      loads: "read-write",
      hos: "read-write",
      money: "read-write",
      documents: "read-write",
      email: "read-write",
      maps: "read-write",
      "app-actions": "read-write",
      calls: "gated",
      signature: "never",
    },
  },
  "dispatch-scout": {
    slug: "dispatch-scout",
    displayName: "Dispatch Scout",
    seat: "load planner",
    status: "planned",
    toolScope: {
      loads: "read",
      hos: "read",
      money: "read",
      documents: "read",
      email: "read",
      maps: "draft",
      "app-actions": "draft",
      calls: "gated",
      signature: "never",
    },
  },
  tracker: {
    slug: "tracker",
    displayName: "Tracker",
    seat: "check-calls and ETA",
    status: "planned",
    toolScope: {
      loads: "read",
      hos: "read",
      money: "none",
      documents: "read",
      email: "none",
      maps: "read",
      "app-actions": "draft",
      calls: "gated",
      signature: "never",
    },
  },
  "compliance-watchdog": {
    slug: "compliance-watchdog",
    displayName: "Compliance Watchdog",
    seat: "HOS and safety alerts",
    status: "planned",
    toolScope: {
      loads: "read",
      hos: "read",
      money: "none",
      documents: "read",
      email: "none",
      maps: "read",
      "app-actions": "flag",
      calls: "never",
      signature: "never",
    },
  },
  maintenance: {
    slug: "maintenance",
    displayName: "Maintenance",
    seat: "PM and inspections",
    status: "planned",
    toolScope: {
      loads: "read",
      hos: "none",
      money: "read",
      documents: "read",
      email: "read",
      maps: "none",
      "app-actions": "draft",
      calls: "gated",
      signature: "never",
    },
  },
  billing: {
    slug: "billing",
    displayName: "Billing",
    seat: "invoice drafter",
    status: "planned",
    toolScope: {
      loads: "read",
      hos: "none",
      money: "read",
      documents: "read",
      email: "read",
      maps: "none",
      "app-actions": "draft",
      calls: "gated",
      signature: "never",
    },
  },
  auditor: {
    slug: "auditor",
    displayName: "Auditor",
    seat: "fact-checker",
    status: "planned",
    toolScope: {
      loads: "read",
      hos: "read",
      money: "read",
      documents: "read",
      email: "read",
      maps: "read",
      "app-actions": "flag",
      calls: "never",
      signature: "never",
    },
  },
};

export function isBotSlug(value: string): value is BotSlug {
  return (BOT_SLUGS as readonly string[]).includes(value);
}

export function botIdentity(slug: BotSlug): BotIdentity {
  return BOT_REGISTRY[slug];
}

/** The scope one bot has on one tool group. Unknown bot/group = "none". */
export function toolScopeFor(slug: string, group: ToolGroup): ToolScope {
  if (!isBotSlug(slug)) return "none";
  return BOT_REGISTRY[slug].toolScope[group];
}

/** Read access: "read", "draft", "read-write", or "flag" all read. */
export function canRead(slug: string, group: ToolGroup): boolean {
  const scope = toolScopeFor(slug, group);
  return scope === "read" || scope === "draft" || scope === "read-write" || scope === "flag";
}

/**
 * Draft access: the bot may write drafts / internal notes, never
 * anything anyone outside the app would see. "draft" and "read-write"
 * both qualify; "flag" does not (a flag is its own channel).
 */
export function canDraft(slug: string, group: ToolGroup): boolean {
  const scope = toolScopeFor(slug, group);
  return scope === "draft" || scope === "read-write";
}

/**
 * Flag access: a bot that holds "flag" scope anywhere may flag
 * anything it can read — a flag is a note about what it read, posted
 * in the group chat. It is not a write to the group it flags. Bots
 * without any "flag" scope cannot flag at all.
 */
export function canFlag(slug: string, group: ToolGroup): boolean {
  if (!isBotSlug(slug)) return false;
  const scope = BOT_REGISTRY[slug].toolScope;
  const holdsFlagScope = (Object.values(scope) as ToolScope[]).includes("flag");
  return holdsFlagScope && canRead(slug, group);
}

/**
 * The tool groups one bot is allowed to see at all. The gateway offers
 * exactly this list to the model — a bot cannot call what it cannot see.
 */
export function visibleToolGroups(slug: string): ToolGroup[] {
  if (!isBotSlug(slug)) return [];
  const scope = BOT_REGISTRY[slug].toolScope;
  return (Object.keys(scope) as ToolGroup[]).filter((group) => scope[group] !== "none" && scope[group] !== "never");
}

/** Bots wired into the Telegram group in this phase (Phase 0). */
export const GROUP_SEATS_PHASE_0: BotSlug[] = ["abel", "dispatch-scout"];
