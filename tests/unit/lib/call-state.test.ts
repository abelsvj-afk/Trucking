// Audit F-006/F-017: the outbound call state machine.
import { describe, expect, it } from "vitest";
import { nextCallState, type CallRowState } from "@/lib/call-state";

const T = "2026-11-20T15:00:00.000Z";
const row = (status: CallRowState["status"], extra: Partial<CallRowState> = {}): CallRowState => ({
  status, started_at: null, outcome: null, transcript: null, telnyx_conversation_id: null, ...extra,
});

describe("outbound call state machine", () => {
  it("hangup and conversation.ended for the same call: the first finishes it, the second changes nothing", () => {
    const first = nextCallState(row("in_progress", { started_at: "2026-11-20T14:58:00.000Z" }), { type: "call.hangup", nowIso: T });
    expect(first).toMatchObject({ finished: true, patch: { status: "completed", duration_seconds: 120 } });
    expect(nextCallState(row("completed"), { type: "call.conversation.ended", nowIso: T })).toEqual({ patch: null, finished: false });
  });

  it("final states stay final: a late answered, hangup or repeat never reopens or re-ends a call", () => {
    for (const status of ["completed", "failed", "no_answer", "voicemail"] as const) {
      for (const type of ["call.answered", "call.hangup", "call.conversation.ended"]) {
        expect(nextCallState(row(status), { type, nowIso: T })).toEqual({ patch: null, finished: false });
      }
    }
  });

  it("the transcript may still arrive after the call ended, and never blanks what is there", () => {
    expect(nextCallState(row("completed"), { type: "call.conversation_insights.generated", nowIso: T, transcript: "They said 3 PM.", summary: "ETA 3 PM" }))
      .toEqual({ patch: { transcript: "They said 3 PM.", outcome: "ETA 3 PM" }, finished: false });
    expect(nextCallState(row("completed", { transcript: "x" }), { type: "call.conversation_insights.generated", nowIso: T }))
      .toEqual({ patch: null, finished: false });
  });

  it("answered keeps the first start time; an abnormal hangup is failed with its cause", () => {
    expect(nextCallState(row("dialing", { started_at: "2026-11-20T14:59:00.000Z" }), { type: "call.answered", nowIso: T }).patch)
      .toEqual({ status: "in_progress", started_at: "2026-11-20T14:59:00.000Z" });
    expect(nextCallState(row("dialing"), { type: "call.hangup", nowIso: T, hangupCause: "USER_BUSY" }).patch)
      .toMatchObject({ status: "failed", outcome: "Call ended: USER_BUSY" });
  });
});
