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
