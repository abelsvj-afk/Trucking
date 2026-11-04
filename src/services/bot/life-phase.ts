// Abel Intelligence Upgrade, Phase C (design §2 + the owner's
// life-phase scope, 2026-11-02). Abel's answers must be framed for
// the phase of life/business the owner is actually IN - today the
// lease-on learning seat, later his own truck and authority. This
// block is assembled in CODE (never model-elected, like every
// context block): the default text derives from the seat the
// design documents, it names the pay pin's state so framing and
// money truth agree, and the owner can replace the phase wholesale
// with a "Life phase" business_fact (stored through the same
// propose->approve memory path as everything else) when his
// situation changes - the day he buys the truck, this block flips
// by his word, not by a code deploy.

import { isPinned, type PayPin } from "./pay-pin";

export const LIFE_PHASE_SUBJECT = "Life phase";

/**
 * The life-phase context block. `override` is the fact text of his
 * "Life phase" business_fact when one is current; otherwise the
 * default lease-on learning-seat framing is derived (pin-aware).
 */
export function buildLifePhaseText(pin: PayPin, override: string | null): string {
  if (override) {
    return (
      `LIFE PHASE (his words, current): ${override} ` +
      "Frame answers for THIS phase - what it makes urgent, what it makes premature, and what today is teaching him for the next one."
    );
  }
  const pinNote = isPinned(pin)
    ? `His pay structure is pinned (${pin.model}${pin.rate != null ? ` at ${pin.rate}` : ""}) - the money lessons run on the real model.`
    : "His pay structure is NOT pinned yet - pinning it down is one of the phase's open lessons, and every settlement or Steven message is evidence toward it.";
  return (
    "LIFE PHASE: He is in the lease-on learning seat - driving Steven's second truck under the carrier Steven is leased to. " +
    "He is NOT a W-2 fleet driver and NOT yet an owner-operator; this seat is deliberately business school: he is learning how money moves " +
    "(carrier cut, truck share, his pay) from inside real loads, while saving toward his own truck and his own authority. " +
    pinNote +
    " Frame answers for this phase: what he earns and keeps now, what each load teaches about the business, and what transfers when the truck is his - " +
    "never frame him as a career company driver, and never as if he already owns the truck."
  );
}
