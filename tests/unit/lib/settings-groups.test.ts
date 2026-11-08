import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS_GROUPS, splitLabel } from "@/lib/settings-groups";

describe("settings by task", () => {
  it("a long capability description moves behind an expander; a short label is untouched", () => {
    expect(splitLabel("Bot chat (Telegram + web assistant)")).toEqual({ name: "Bot chat", detail: "Telegram + web assistant" });
    expect(splitLabel("Game Plan")).toEqual({ name: "Game Plan", detail: null });
  });
  it("every group in the jump bar has a heading on the page, in the same order", () => {
    const page = readFileSync("src/app/(app)/more/settings/page.tsx", "utf8");
    const positions = SETTINGS_GROUPS.map((g) => page.indexOf(`id="${g.id}"`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
  it("pay settings come first and sign-out last", () => {
    const page = readFileSync("src/app/(app)/more/settings/page.tsx", "utf8");
    expect(page.indexOf("<PayTermsSettings />")).toBeLessThan(page.indexOf("<HosCarrierSettings />"));
    expect(page.lastIndexOf('aria-label="Sign out"')).toBeGreaterThan(page.indexOf('aria-label="AI authorization"'));
  });
});
