/**
 * P2-1 (telegram audit 2026-11-06): when the code appends its own proposal block ("I have NOT recorded
 * this yet. Reply YES..."), the model's own copy of that request is a duplicate - and it sometimes
 * contradicted the block (asking YES for something that was never staged). The code's block is the
 * one source of truth, so the model's confirmation prose is removed from the reply.
 */
const CONFIRMATION_PROSE: RegExp[] = [
  /[^.!?\n]*\b(?:please\s+)?reply\s+(?:with\s+)?["“']?yes["”']?\b[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\bI\s*(?:have|'ve|’ve)\s+not\s+(?:recorded|saved|logged)\b[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\b(?:just\s+)?(?:say|tell\s+me|send)\s+["“']?yes["”']?\s+(?:to|and|if)\b[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\b(?:shall|should)\s+I\s+(?:go\s+ahead\s+and\s+)?(?:record|save|log|add)\b[^?\n]*\?/gi,
];

/**
 * Model-facing instruction lines that ride inside some tool results (a draft
 * display used to end with "Show him all of this... then call send_email...").
 * Tool results are grounding text for the MODEL; when an executed proposal's
 * result is quoted back to the owner after his yes (resolvePending), these
 * lines are stripped first - he must never see instructions meant for the
 * model (live leak 2026-11-07, when a draft-save result was read back whole).
 */
const MODEL_ONLY_LINE: RegExp[] = [
  /^\s*show him\b.*$/i,
  /^\s*then call\s+\w+.*$/i,
  /^\s*call\s+\w+\s+with\s+this\s+.*$/i,
  /^\s*if he wants a change,?\s+call\s+.*$/i,
  /^\s*nothing is sent until he says to send this text:.*$/i,
  /^\s*model note\b.*$/i,
];

export function stripModelOnlyLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !MODEL_ONLY_LINE.some((p) => p.test(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripConfirmationProse(reply: string): string {
  let out = reply;
  for (const pattern of CONFIRMATION_PROSE) out = out.replace(pattern, "");
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
