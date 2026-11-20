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
// JOB CLAIMING (research pattern, applied 2026-11-19): a POST claims
// the sweep in the audit log (action 'sweep_claim', fingerprint per
// Eastern day); a second POST within 15 minutes is an idempotent
// no-op. One sweep owns the room at a time; retries never double up.
//
// TEAM ROOM (owner's model, 2026-11-19): the sweep also talks to its
// teammates by name in the room — Dispatch Scout hears a compliance
// hold before a load is offered, Tracker gets asked for the truck's
// position when a deadline affects a run. Each team post is backed
// by a structured handoff record (validated state only) and deduped
// to once per Eastern day per state; at most two team posts per
// sweep (bounded loops). The owner sees every exchange in the room.
//
// FACES (owner, 2026-11-19): Watchdog posts through its OWN Telegram
// account when TELEGRAM_COMPLIANCE_WATCHDOG_BOT_TOKEN is set (its own
// BotFather account + profile photo, owner-created — the remaining
// owner step); until then it posts through the group's shared token
// prefixed with its name. The send lines below are the binding
// point. If no token or no group id is configured, nothing posts and
// the response says so honestly.

import { NextRequest, NextResponse } from "next/server";
import { todayEastern } from "@/lib/eastern-date";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import {
  alertFingerprint,
  checkLoadLegality,
  formatComplianceAlert,
  formatDefectAlert,
  recordHandoff,
  runWatchdogSweep,
  type ComplianceDeadlineKind,
  type EvaluatedDeadline,
} from "@/services/bots/compliance-watchdog";
import { createBotTeamStore } from "@/services/bots/store";
import { getTelegramConfig } from "@/services/telegram/dispatch-bot";
import { sendTelegramMessage } from "@/services/telegram/bot-api";

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLAIM_WINDOW_MS = 15 * 60 * 1000;

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

  // Job claiming: one sweep at a time. A claim is an audit row; a
  // POST inside the window of a claimed sweep posts nothing and
  // says so. A failed claim lookup runs the sweep anyway — a
  // duplicate sweep is a nuisance, a silently skipped one is a
  // safety gap.
  const claimFingerprint = `sweep|${todayEastern()}`;
  try {
    const alreadyClaimed = await store.hasRecentAuditFingerprint({
      action: "sweep_claim",
      fingerprint: claimFingerprint,
      sinceIso: new Date(Date.now() - CLAIM_WINDOW_MS).toISOString(),
    });
    if (alreadyClaimed) {
      return NextResponse.json(
        {
          data: {
            claimed: false,
            posted: [] as string[],
            teamPosted: [] as string[],
            note: "A Watchdog sweep already ran in the last 15 minutes — this run posted nothing (job claiming: one sweep owns the room at a time; retries are idempotent).",
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    await store.logAudit({
      botSlug: "compliance-watchdog",
      actor: "bot",
      action: "sweep_claim",
      targetRef: null,
      detail: { fingerprint: claimFingerprint },
    });
  } catch (err) {
    console.error("[bot-team] watchdog sweep claim failed — running the sweep anyway", err);
  }

  const sweep = await runWatchdogSweep({ store });
  const alerts = postableAlerts(sweep);

  const config = getTelegramConfig();
  // Faces: Watchdog's own token when set; the shared token (with the
  // name prefix) until the owner creates its BotFather account.
  const ownToken = process.env.TELEGRAM_COMPLIANCE_WATCHDOG_BOT_TOKEN;
  const sendToken = ownToken ?? config.botToken;
  const namePrefix = ownToken ? "" : "Compliance Watchdog: ";
  if (!sendToken || !config.groupChatId) {
    return NextResponse.json(
      {
        data: {
          claimed: true,
          summary: sweep.summary,
          counts: sweep.counts,
          posted: [] as string[],
          skipped: [] as string[],
          teamPosted: [] as string[],
          groupPosted: false,
          note: "Telegram group is not configured on the server (no bot token / TELEGRAM_GROUP_CHAT_ID) — alerts were evaluated but not posted.",
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
      await sendTelegramMessage(sendToken, Number(config.groupChatId), `${namePrefix}${alert.text}`);
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
  // Team-room posts: Scout's hold and Tracker's position ask,
  // addressed by name in the room, each backed by a handoff record
  // and deduped by fingerprint (the hold re-posts when the red set
  // changes; the position ask is once per deadline per day). At
  // most two per sweep — bounded, like everything bot-to-bot here.
  const teamPosted: string[] = [];
  const teamPosts: {
    to: "dispatch-scout" | "tracker";
    text: string;
    fingerprint: string;
    reason: string;
    deadlineKind?: ComplianceDeadlineKind;
  }[] = [];
  if (sweep.scoutHold) {
    teamPosts.push({
      to: "dispatch-scout",
      text: sweep.scoutHold,
      fingerprint: `team-hold|${todayEastern()}|${sweep.checklist.reds.map((r) => r.kind).join(",")}|${sweep.defects.length}`,
      reason: "proactive compliance hold posted in the room — Scout hears it before a load is offered",
    });
  }
  if (sweep.trackerRequest) {
    teamPosts.push({
      to: "tracker",
      text: sweep.trackerRequest.text,
      fingerprint: `team-position|${todayEastern()}|${sweep.trackerRequest.deadlineKind}`,
      reason: "position requested in the room — the deadline affects the current run",
      deadlineKind: sweep.trackerRequest.deadlineKind,
    });
  }
  for (const post of teamPosts.slice(0, 2)) {
    try {
      if (await store.hasRecentAuditFingerprint({ action: "handoff", fingerprint: post.fingerprint, sinceIso })) {
        continue;
      }
    } catch (err) {
      console.error("[bot-team] watchdog team-post dedupe lookup failed — posting anyway", err);
    }
    try {
      await sendTelegramMessage(sendToken, Number(config.groupChatId), `${namePrefix}${post.text}`);
      teamPosted.push(post.text);
      await recordHandoff({
        store,
        to: post.to,
        reason: post.reason,
        deadlineKind: post.deadlineKind ?? null,
        fingerprint: post.fingerprint,
      });
    } catch (err) {
      console.error("[bot-team] watchdog team post failed", err);
    }
  }

  return NextResponse.json(
    {
      data: {
        claimed: true,
        summary: sweep.summary,
        counts: sweep.counts,
        posted,
        skipped,
        teamPosted,
        groupPosted: posted.length > 0 || teamPosted.length > 0,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
