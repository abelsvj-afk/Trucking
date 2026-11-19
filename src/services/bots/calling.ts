// Calling hook — STUB ONLY (Phase 0 baseline).
// The bots that need to call (Dispatch Scout, Tracker, Billing,
// Maintenance, Abel) share ONE number, +1 320-369-0102 (Telnyx), in
// the owner's ElevenLabs voice. They take turns, never two at once.
// NEVER offer a human handoff unless the person explicitly asks —
// the bot handles the call, connects the owner only on request.
// Every call is logged.
//
// Calling is NOT live today: the ElevenLabs voice pick and the AI
// assistant connection are still open, and no live call happens
// without the owner's word. UPDATE 2026-11-19: the Telnyx API key HAS
// arrived (secure connector custom.telnyx) and the outbound voice
// profile was created + attached via the API — outbound calling is
// unlocked at the account level. This module stays a stub in the
// baseline anyway: it refuses every call with the reason, so nothing
// can dial by accident. Do NOT wire a real Telnyx call here until the
// voice + assistant are connected and the owner says so.

export interface CallPlan {
  botSlug: string;
  to: string;
  purpose: string;
  /** The owner-approved call plan this call belongs to. */
  approvedProposalId: string | null;
}

export type CallRequestResult =
  | { ok: true; callId: string }
  | { ok: false; reason: string };

export const CALLING_NOT_LIVE_REASON =
  "Calling is not live yet — the Telnyx outbound setup is still open. No call was placed.";

export function requestCall(_plan: CallPlan): CallRequestResult {
  return { ok: false, reason: CALLING_NOT_LIVE_REASON };
}

/** The shared number, copied exactly. The bots never dial any other number. */
export const SHARED_CALLING_NUMBER = "+1 320-369-0102";
