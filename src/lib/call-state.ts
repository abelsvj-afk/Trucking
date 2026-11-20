// Outbound call lifecycle (audit F-006/F-017, design: docs/design/outbound-calling.md
// "Call state machine"). Pure: one Telnyx event + the row as it is -> the change to make.
//
// Rules:
//  - completed / failed / no_answer / voicemail are FINAL: a late or repeated event never
//    changes the status, ended_at or duration again (Telnyx retries webhooks and sends
//    hangup AND conversation.ended for the same call, in either order).
//  - the transcript / summary may still arrive after the call ended (insights come last);
//    they fill in, never overwrite what is already there with nothing.
//  - `finished` is true only on the event that MOVED the call into a final state: that is
//    the one moment the next queued call may be dialed (a repeat never dials twice).

export const FINAL_CALL_STATUSES = ["completed", "failed", "no_answer", "voicemail"] as const;
export type CallStatus = "queued" | "dialing" | "in_progress" | (typeof FINAL_CALL_STATUSES)[number];

export interface CallRowState {
  status: CallStatus;
  started_at: string | null;
  outcome: string | null;
  transcript: string | null;
  telnyx_conversation_id: string | null;
}

export interface CallEventInput {
  type: string;
  nowIso: string;
  conversationId?: string | null;
  hangupCause?: string | null;
  transcript?: string | null;
  summary?: string | null;
}

export interface CallTransition {
  patch: Record<string, unknown> | null;
  /** This event finished the call (first time only): dial the next queued one. */
  finished: boolean;
}

export function isFinalCallStatus(status: string): boolean {
  return (FINAL_CALL_STATUSES as readonly string[]).includes(status);
}

const NONE: CallTransition = { patch: null, finished: false };

export function nextCallState(row: CallRowState, e: CallEventInput): CallTransition {
  const final = isFinalCallStatus(row.status);
  switch (e.type) {
    case "call.answered":
      if (final || row.status === "in_progress") return NONE;
      return { patch: { status: "in_progress", started_at: row.started_at ?? e.nowIso }, finished: false };
    case "call.conversation.ended":
      if (final) return NONE;
      return {
        patch: { status: "completed", telnyx_conversation_id: e.conversationId ?? row.telnyx_conversation_id, ended_at: e.nowIso },
        finished: true,
      };
    case "call.hangup": {
      if (final) return NONE;
      const cause = e.hangupCause ?? "";
      const normal = cause === "" || cause.toLowerCase() === "normal_clearing";
      const duration = row.started_at ? Math.max(0, Math.round((Date.parse(e.nowIso) - Date.parse(row.started_at)) / 1000)) : null;
      return {
        patch: {
          status: normal ? "completed" : "failed",
          outcome: normal ? (row.outcome ?? "Call ended.") : `Call ended: ${cause}`,
          ended_at: e.nowIso,
          duration_seconds: duration,
        },
        finished: true,
      };
    }
    case "call.conversation_insights.generated": {
      const patch: Record<string, unknown> = {};
      if (e.transcript) patch.transcript = e.transcript;
      if (e.summary) patch.outcome = e.summary;
      return { patch: Object.keys(patch).length ? patch : null, finished: false };
    }
    default:
      return NONE;
  }
}
