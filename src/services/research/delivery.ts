// Deep Research Engine delivery timing (2026-11-02 design, D-6).
// Pure functions, unit-tested: a briefing's buzz should arrive on the
// owner's schedule, not the engine's. Classes: urgent (hard
// legal/safety) sends immediately, once; trip (corridor-relevant) and
// routine obey quiet hours (21:00-06:00 America/New_York) and a
// driving-aware hold read from his duty logs. The briefing itself is
// always in the app instantly - only the Telegram buzz waits.

import { TOPIC_EMOJI } from "@/lib/research-topics";
import type { ResearchConfig } from "./config";
import { signalDieselPct, signalTouchesStates } from "./triggers";
import type { PressureSignal } from "./watchers/types";

export type DeliveryClass = "urgent" | "trip" | "routine";

const ET_ZONE = "America/New_York";

export function etHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

/** The next moment (strictly after `from`) whose Eastern hour equals `hour`. */
export function nextEtHour(from: Date, hour: number): Date {
  const stepMs = 15 * 60 * 1000;
  let candidate = new Date(from.getTime() + stepMs);
  for (let i = 0; i < 8 * 24 * 4; i++) {
    if (etHour(candidate) === hour) {
      // Round down to the top of that hour in absolute time terms:
      // stepping in 15-minute increments from an arbitrary start can
      // land at :15/:30/:45 inside the target hour - walk back to its
      // first minute so "holds until 06:00" means 06:00, not 06:37.
      const start = new Date(candidate.getTime());
      while (start.getTime() - stepMs > from.getTime() && etHour(new Date(start.getTime() - stepMs)) === hour) {
        start.setTime(start.getTime() - stepMs);
      }
      return start;
    }
    candidate = new Date(candidate.getTime() + stepMs);
  }
  return candidate;
}

/** "21:00" for 21 - the hold-reason copy is built from these so it can never drift from the configured window (CD-8). */
export function formatEtHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function isQuietHours(now: Date, config: ResearchConfig): boolean {
  const hour = etHour(now);
  const { deliveryQuietStartHourEt: start, deliveryQuietEndHourEt: end } = config;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/**
 * Classify a briefing from the signals that produced it (D-6):
 * urgent = final/enacted law at top magnitude, warning-class weather,
 * or a diesel spike >= 6%; trip = any producing signal touches his
 * corridor states; otherwise routine.
 */
export function classifyDelivery(input: {
  signals: PressureSignal[];
  corridorStates?: string[];
}): DeliveryClass {
  const { signals, corridorStates } = input;
  for (const signal of signals) {
    if (
      (signal.watcherKey === "federal_register" || signal.watcherKey === "openstates") &&
      signal.magnitude >= 0.9
    ) {
      return "urgent";
    }
    if (signal.watcherKey === "nws_weather") {
      const rank = signal.data.severityRank;
      if (typeof rank === "number" && rank >= 4) return "urgent";
    }
    const pct = signalDieselPct(signal);
    if (pct !== null && Math.abs(pct) >= 6) return "urgent";
  }
  if (signals.some((s) => signalTouchesStates(s, corridorStates))) return "trip";
  return "routine";
}

export interface DeliveryDecision {
  sendNow: boolean;
  heldUntil: Date | null;
  reason: string | null;
}

export function deliveryDecision(input: {
  now: Date;
  deliveryClass: DeliveryClass;
  latestDutyStatus: string | null;
  config: ResearchConfig;
}): DeliveryDecision {
  const { now, deliveryClass, latestDutyStatus, config } = input;
  if (deliveryClass === "urgent") return { sendNow: true, heldUntil: null, reason: null };

  const holds: Array<{ until: Date; reason: string }> = [];
  if (isQuietHours(now, config)) {
    holds.push({
      until: nextEtHour(now, config.deliveryQuietEndHourEt),
      reason: `quiet hours (${formatEtHour(config.deliveryQuietStartHourEt)}-${formatEtHour(config.deliveryQuietEndHourEt)} ET)`,
    });
  }
  if (latestDutyStatus === "driving" || latestDutyStatus === "on_duty") {
    holds.push({
      until: new Date(now.getTime() + config.deliveryHoldMaxHours * 60 * 60 * 1000),
      reason: `he is ${latestDutyStatus === "driving" ? "driving" : "on duty"}`,
    });
  }
  const [firstHold] = holds;
  if (!firstHold) return { sendNow: true, heldUntil: null, reason: null };

  const heldUntil = holds.reduce((max, h) => (h.until > max ? h.until : max), firstHold.until);
  return {
    sendNow: false,
    heldUntil,
    reason: `Held: ${holds.map((h) => h.reason).join(" + ")}.`,
  };
}

// The topic emoji map lives in lib/research-topics.ts (Home News
// Banner design §3) so Telegram, the banner, and the Research tab
// share one copy - TOPIC_EMOJI is imported at the top of this file.

export interface BriefingMessageShape {
  topic: string;
  title: string;
  headline: string;
  counterMove: string;
  takeaway: string;
}

/** The single-briefing Telegram text (D-6 format: the counter-move is the part he acts on). */
export function formatBriefingMessage(briefing: BriefingMessageShape): string {
  const emoji = TOPIC_EMOJI[briefing.topic] ?? "📰";
  return `${emoji} ${briefing.title}\n${briefing.headline}\nCounter-move: ${briefing.counterMove}\nTakeaway: ${briefing.takeaway}\nFull briefing: app → More → Research`;
}

/** The digest text when held briefings flush together (D-6). */
export function formatDigestMessage(briefings: BriefingMessageShape[]): string {
  const [only] = briefings;
  if (briefings.length === 1 && only) return formatBriefingMessage(only);
  const lines = briefings.map((b) => `• ${b.title} - ${b.headline}`);
  return `While you were rolling: ${briefings.length} research briefings\n${lines.join("\n")}\nFull briefings: app → More → Research`;
}
