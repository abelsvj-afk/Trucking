// BT-007/BT-008: per-bot Telegram health and one next step per unhealthy state.
import { describe, expect, it, vi } from "vitest";
import { buildWebhookReport, getTeamWebhookReports } from "@/services/telegram/webhook-admin";

const ALL = ["message", "edited_message", "callback_query"];

function telegram(byToken: Record<string, { username: string; url: string; allowed?: string[]; error?: string; pending?: number }>) {
  return vi.fn(async (url: string) => {
    const [, token, method] = /bot([^/]+)\/(\w+)$/.exec(String(url))!;
    const bot = byToken[token!]!;
    const result = method === "getMe"
      ? { username: bot.username }
      : { url: bot.url, allowed_updates: bot.allowed ?? ALL, pending_update_count: bot.pending ?? 0, ...(bot.error ? { last_error_message: bot.error, last_error_date: 1_800_000_000 } : {}) };
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
}

describe("team webhook reports", () => {
  it("reports each face; flags a token that belongs to another bot; never returns a token", async () => {
    const faces = [
      { slug: "abel", name: "Abel", username: "AbelExecutiveBot", tokenEnvVar: "TELEGRAM_BOT_TOKEN", token: "111:abel" },
      { slug: "dispatch-scout", name: "Dispatch Scout", username: "DispatchScoutBot", tokenEnvVar: "TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN", token: "222:scout" },
      { slug: "billing", name: "Billing", username: null, tokenEnvVar: "TELEGRAM_BILLING_BOT_TOKEN", token: null },
    ];
    const fetchImpl = telegram({
      "111:abel": { username: "AbelExecutiveBot", url: "https://app.example/api/telegram/webhook" },
      "222:scout": { username: "AbelExecutiveBot", url: "https://app.example/api/telegram/webhook?bot=dispatch-scout" },
    });
    const [abel, scout, billing] = await getTeamWebhookReports(faces, "s3cr3t-value", fetchImpl);
    expect(abel!.report.healthy).toBe(true);
    expect(abel!.report.nextStep.kind).toBe("none");
    expect(scout!.report.healthy).toBe(false);
    expect(scout!.report.findings[0]).toContain("belongs to @AbelExecutiveBot, not @DispatchScoutBot");
    expect(scout!.report.nextStep).toMatchObject({ kind: "server" });
    expect(scout!.report.findings.join(" ")).not.toContain("Telegram is delivering");
    expect(billing!.report.configured).toBe(false);
    expect(billing!.report.nextStep.text).toContain("TELEGRAM_BILLING_BOT_TOKEN");
    expect(JSON.stringify([abel, scout, billing])).not.toMatch(/111:abel|222:scout|s3cr3t-value/);
  });

  it("every unhealthy state maps to one next step (BT-008)", () => {
    const face = { name: "Dispatch Scout", tokenEnvVar: "T", webhookQuery: "?bot=dispatch-scout" };
    expect(buildWebhookReport({ url: "" }, true, true, face).nextStep).toMatchObject({ kind: "server", text: expect.stringContaining("?bot=dispatch-scout") });
    expect(buildWebhookReport({ url: "https://a/x", allowed_updates: ALL }, false, true, face).nextStep).toMatchObject({ kind: "server", text: expect.stringContaining("TELEGRAM_WEBHOOK_SECRET") });
    expect(buildWebhookReport({ url: "https://a/x", allowed_updates: ["message"] }, true, true, face).nextStep.kind).toBe("repair");
    expect(buildWebhookReport({ url: "https://a/x", allowed_updates: ALL, last_error_message: "Wrong response from the webhook: 401 Unauthorized", pending_update_count: 3 }, true, true, face).nextStep.kind).toBe("repair");
    expect(buildWebhookReport({ url: "https://a/x", allowed_updates: ALL }, true, true, face).nextStep.kind).toBe("none");
  });
});
