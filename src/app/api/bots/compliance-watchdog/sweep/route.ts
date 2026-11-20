// POST /api/bots/compliance-watchdog/sweep — run the Watchdog sweep
// and post red/amber alerts to the team group. GET — the current
// checklist evaluation, read-only, no posting.
// Session-authenticated like every v1 route; company-scoped. This is
// the trigger for the Watchdog's own turn (a deadline near, a flag
// going red): no automatic schedule exists yet — the owner (or a later
// scheduler) calls POST. A re-run is idempotent for amber alerts (a
// fingerprint already posted in the last 24 hours is skipped); a red
// alert is always posted — a missed red alert is worse than a
// duplicate one, and a failed dedupe lookup never blocks a red.
//
// Alerts post as Compliance Watchdog through the group's Telegram
// bot. FACES (owner, 2026-11-19): each bot gets its own Telegram
// account + photo, messaging as itself — the one-face model was
// rejected. Until the shared backend binds per-bot tokens, lines post
// through the single token (TELEGRAM_BOT_TOKEN) prefixed with the
// bot's name; the send call below is the binding point. If the token
// or group id is not configured, nothing posts and the response says
// so honestly.

import { NextRequest, NextResponse } from "next/server";
import { todayEastern } from "@/lib/eastern-date";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import {
  alertFingerprint,
  checkLoadLegality,
  formatComplianceAlert,
  formatDefectAlert,
  runWatchdogSweep,
  type EvaluatedDeadline,
} from "@/services/bots/compliance-watchdog";
import { createBotTeamStore } from "@/services/bots/store";
import { getTelegramConfig } from "@/services/telegram/dispatch-bot";
import { sendTelegramMessage } from "@/services/telegram/bot-api";

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface PostableAlert {
  text: string;
  fingerprint: string;
  severity: "red" | "amber";
  kind: string;
}

function postableAlerts(sweep: Awaited<ReturnType<typeof runWatchdogSweep>>): PostableAlert[] {
  const out: PostableAlert[] = [];
  const push = (deadline: EvaluatedDeadline) => {
    out.push({
      text: formatComplianceAlert(deadline),
      fingerprint: alertFingerprint({
        kind: deadline.kind,
        subjectRef: deadline.subjectRef,
        severity: deadline.severity,
        dueDate: deadline.dueDate,
      }),
      severity: deadline.severity === "red" ? "red" : "amber",
      kind: deadline.kind,
    });
  };
  for (const red of sweep.checklist.reds) push(red);
  for (const amber of sweep.checklist.ambers) push(amber);
  for (const defect of sweep.defects) {
    out.push({
      text: formatDefectAlert({ id: defect.id, description: defect.description, source: defect.source, createdAt: defect.createdAt }),
      fingerprint: `dvir_defect|${defect.id}|red|`,
      severity: "red",
      kind: "dvir_defect",
    });
  }
  if (sweep.hosFlag) {
    out.push({
      text: `${sweep.hosFlag.severity === "red" ? "RED" : "AMBER"} — HOS: ${sweep.hosFlag.message}`,
      fingerprint: `hos-coverage||${sweep.hosFlag.severity}|${todayEastern()}`,
      severity: sweep.hosFlag.severity,
      kind: "hos-coverage",
    });
  }
  return out;
}

export const GET = createApiHandler(async (_req: NextRequest, ctx) => {
  const store = createBotTeamStore(ctx.auth.companyId);
  if (!store) {
    throw validationError("Bot team storage is not configured on the server (TELEGRAM_COMPANY_ID / Supabase keys).");
  }
  const sweep = await runWatchdogSweep({ store });
  const legality = checkLoadLegality({ checklist: sweep.checklist, defects: sweep.defects });
  return NextResponse.json(
    {
      data: {
        checklist: sweep.checklist.evaluated,
        counts: sweep.counts,
        defects: sweep.defects,
        hosFlag: sweep.hosFlag,
        legality: legality.verdict,
        legalitySummary: legality.summary,
        summary: sweep.summary,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const POST = createApiHandler(async (_req: NextRequest, ctx) => {
  const store = createBotTeamStore(ctx.auth.companyId);
  if (!store) {
    throw validationError("Bot team storage is not configured on the server (TELEGRAM_COMPANY_ID / Supabase keys).");
  }
  const sweep = await runWatchdogSweep({ store });
  const alerts = postableAlerts(sweep);

  const config = getTelegramConfig();
  if (!config.botToken || !config.groupChatId) {
    return NextResponse.json(
      {
        data: {
          summary: sweep.summary,
          counts: sweep.counts,
          posted: [] as string[],
          skipped: [] as string[],
          groupPosted: false,
          note: "Telegram group is not configured on the server (TELEGRAM_BOT_TOKEN / TELEGRAM_GROUP_CHAT_ID) — alerts were evaluated but not posted.",
          alerts: alerts.map((a) => a.text),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  const posted: string[] = [];
  const skipped: string[] = [];
  for (const alert of alerts) {
    // Amber dedupe: skip when the lookup positively says this exact
    // alert posted in the last 24 hours. A lookup failure posts
    // anyway (log it) — a duplicate amber is a nuisance; a missed
    // alert is a safety gap. Red alerts are never deduped away.
    if (alert.severity === "amber") {
      try {
        if (await store.hasRecentAlert(alert.fingerprint, sinceIso)) {
          skipped.push(alert.text);
          continue;
        }
      } catch (err) {
        console.error("[bot-team] watchdog alert dedupe lookup failed — posting anyway", err);
      }
    }
    try {
      await sendTelegramMessage(config.botToken, Number(config.groupChatId), `Compliance Watchdog: ${alert.text}`);
      posted.push(alert.text);
      await store.logAudit({
        botSlug: "compliance-watchdog",
        actor: "bot",
        action: "compliance_alert_posted",
        targetRef: alert.kind,
        detail: { fingerprint: alert.fingerprint, severity: alert.severity, kind: alert.kind },
      });
    } catch (err) {
      console.error("[bot-team] watchdog alert post failed", err);
    }
  }
  return NextResponse.json(
    { data: { summary: sweep.summary, counts: sweep.counts, posted, skipped, groupPosted: posted.length > 0 } },
    { headers: { "Cache-Control": "no-store" } },
  );
});
