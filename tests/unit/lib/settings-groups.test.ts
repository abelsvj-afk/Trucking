import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_GROUPS,
  aiSummaryLine,
  groupByAnchor,
  groupBySlug,
  settingsPath,
  splitLabel,
  summarizeAi,
  summarizeHours,
  summarizeLook,
  summarizePay,
} from "@/lib/settings-groups";
import type { EmployerPayProfile } from "@/types/entities";

const read = (path: string) => readFileSync(path, "utf8");
const VIEW = "src/components/settings/SettingsGroupView.tsx";
const INDEX = "src/app/(app)/more/settings/page.tsx";

describe("settings by task", () => {
  it("a long capability description moves behind an expander; a short label is untouched", () => {
    expect(splitLabel("Bot chat (Telegram + web assistant)")).toEqual({ name: "Bot chat", detail: "Telegram + web assistant" });
    expect(splitLabel("Game Plan")).toEqual({ name: "Game Plan", detail: null });
  });

  it("the six groups are the ones that existed, in the same order (pay first, account last)", () => {
    expect(SETTINGS_GROUPS.map((g) => g.id)).toEqual([
      "settings-pay",
      "settings-hours",
      "settings-connections",
      "settings-look",
      "settings-ai",
      "settings-account",
    ]);
    expect(SETTINGS_GROUPS.map((g) => g.slug)).toEqual(["pay", "hours", "connections", "look", "ai", "account"]);
  });
});

// Settings as an index (docs/design/settings-index.md, 2026-11-12).
describe("settings index", () => {
  it("every group has its own page block, and the view renders exactly those six", () => {
    const view = read(VIEW);
    for (const group of SETTINGS_GROUPS) {
      expect(view).toContain(`{group === "${group.slug}" && (`);
      expect(view).toContain(`id="${group.id}"`);
    }
    expect(view.match(/\{group === "/g)).toHaveLength(SETTINGS_GROUPS.length);
  });

  it("no existing settings block was dropped in the move", () => {
    const view = read(VIEW);
    for (const piece of [
      "<PayTermsSettings />",
      "<HosCarrierSettings />",
      "<BackgroundTrackingSettings />",
      "<TelegramConnectionSettings />",
      "<EmailInboxSettings />",
      'aria-label="Appearance"',
      'aria-label="Home screen"',
      'id="home_business_summary"',
      'aria-label="AI authorization"',
      'id="global_switch"',
      "id={`capability_${capability}`}",
      'aria-label="Sign out"',
    ]) {
      expect(view, piece).toContain(piece);
    }
  });

  it("each block sits under its own group and nowhere else", () => {
    const view = read(VIEW);
    const at = (slug: string) => view.indexOf(`{group === "${slug}" && (`);
    const within = (needle: string, slug: string, next: string | null) => {
      const i = view.indexOf(needle);
      expect(i, needle).toBeGreaterThan(at(slug));
      if (next) expect(i, needle).toBeLessThan(at(next));
      expect(view.indexOf(needle, i + 1), `${needle} appears twice`).toBe(-1);
    };
    within("<PayTermsSettings />", "pay", "hours");
    within("<HosCarrierSettings />", "hours", "connections");
    within("<BackgroundTrackingSettings />", "hours", "connections");
    within("<TelegramConnectionSettings />", "connections", "look");
    within("<EmailInboxSettings />", "connections", "look");
    within('aria-label="Home screen"', "look", "ai");
    within('id="global_switch"', "ai", "account");
    within('aria-label="Sign out"', "account", null);
  });

  it("the index lists the groups and cannot change a setting (no switch, no button, no AI update call)", () => {
    const index = read(INDEX);
    expect(index).toContain("SETTINGS_GROUPS.map((group) =>");
    expect(index).not.toMatch(/<input|<button|updateAiSettings|updateHosSettings|apiClient\.(create|update|remove)/);
  });

  it("paths and old anchors resolve to the same group", () => {
    for (const group of SETTINGS_GROUPS) {
      expect(settingsPath(group.slug)).toBe(`/more/settings/${group.slug}`);
      expect(groupBySlug(group.slug)?.id).toBe(group.id);
      expect(groupByAnchor(`#${group.id}`)?.slug).toBe(group.slug);
      expect(groupByAnchor(group.id)?.slug).toBe(group.slug);
    }
    expect(groupBySlug("nope")).toBeNull();
    expect(groupBySlug(undefined)).toBeNull();
    expect(groupByAnchor("")).toBeNull();
    expect(groupByAnchor("#top")).toBeNull();
    expect(read(INDEX)).toContain("groupByAnchor(window.location.hash)");
  });

  it("links that name a setting open the page that holds it", () => {
    expect(read("src/components/NewsBanner.tsx")).toContain('href="/more/settings/ai"');
    expect(read("src/app/(app)/more/game-plan/page.tsx")).toContain('href="/more/settings/ai"');
    expect(read("src/app/(app)/fleet/hos/page.tsx")).toContain('href="/more/settings/hours"');
    for (const file of [
      "src/components/LoadPaySection.tsx",
      "src/components/DriverPayHomeCard.tsx",
      "src/app/(app)/money/pay/page.tsx",
      "src/app/(app)/money/paychecks/page.tsx",
    ]) {
      expect(read(file), file).toContain('href="/more/settings/pay"');
      expect(read(file), file).not.toContain('href="/more/settings"');
    }
  });
});

describe("index summaries say what is set, or nothing", () => {
  const profile = (over: Partial<EmployerPayProfile>): EmployerPayProfile =>
    ({
      id: "p1",
      employer_name: "Sample Carrier",
      rate_cents_per_mile: 55,
      mile_basis: "all",
      worker_type: "w2",
      fuel_paid_by: "employer",
      percent_of_load_bps: null,
      payday_weekday: 5,
      effective_from: "2026-01-01",
      effective_to: null,
      notes: null,
      updated_at: "2026-01-01T00:00:00Z",
      ...over,
    }) as EmployerPayProfile;

  it("pay: the newest open terms in the driver's words; unknown -> null; none -> says so", () => {
    expect(summarizePay(null)).toBeNull();
    expect(summarizePay([])).toBe("No pay terms yet");
    expect(summarizePay([profile({})])).toBe("Sample Carrier: $0.55/mile, all miles, payday Friday");
    expect(summarizePay([profile({ effective_to: "2026-06-01" })])).toBe("No pay terms yet");
    expect(
      summarizePay([profile({}), profile({ id: "p2", employer_name: "Newer Carrier", effective_from: "2026-09-01", mile_basis: null, payday_weekday: null })]),
    ).toBe("Newer Carrier: $0.55/mile");
  });

  it("hours: the stored cycle and restart; unknown -> null", () => {
    expect(summarizeHours(null)).toBeNull();
    expect(
      summarizeHours({ hos_cycle: "70/8", hos_period_anchor: "00:00", hos_restart_enabled: true, hos_carrier_timezone: "America/New_York" }),
    ).toBe("70 hours in 8 days, 34-hour restart on");
    expect(
      summarizeHours({ hos_cycle: "60/7", hos_period_anchor: "00:00", hos_restart_enabled: false, hos_carrier_timezone: "America/New_York" }),
    ).toBe("60 hours in 7 days, 34-hour restart off");
  });

  it("appearance: the device's own picks", () => {
    expect(summarizeLook("dark", false)).toBe("Dark; business summary on Home hidden");
    expect(summarizeLook("auto", true)).toBe("Follows your phone; business summary on Home shown");
  });

  it("AI: counts the switches; a master switch that is OFF is said first; unknown -> null", () => {
    expect(summarizeAi(null)).toBeNull();
    expect(summarizeAi({ globally_disabled: false, capabilities: { a: true, b: false, c: true } })).toBe("Master switch on, 2 of 3 switches on");
    expect(summarizeAi({ globally_disabled: true, capabilities: { a: true, b: false } })).toBe(
      "Master switch OFF: no AI runs (1 of 2 switches on but held back)",
    );
    expect(aiSummaryLine(null)).toBe("Your account — and the switches that decide what the AI is allowed to do.");
    expect(aiSummaryLine({ globally_disabled: false, capabilities: { a: true, b: true } })).toContain("all 2 AI switches are ON");
  });
});
