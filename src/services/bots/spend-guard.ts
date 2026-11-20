// The spend cap in front of every bot model call (audit F-023/F-024).
// ONE path for every bot (Abel's group turn, Billing, any later seat):
//  - no bot-team store = no cap check = no model call (fail closed);
//  - the cost of a full-length reply is RESERVED atomically before the
//    call (reserve_bot_spend, migration 00109), so two turns arriving
//    together can't both slip under the cap;
//  - after the reply, settle the reservation to the real estimate.

import type { BotSlug } from "./registry";
import type { BotTeamStore } from "./store";
import { estimateCallCostCents, modelForTier, monthlyCapCents, monthStartIso, SPEND_CAP_REACHED_TEXT } from "./spend";

/** The database tables/functions of the bot team (00103, 00109) are missing — not a passing hiccup. */
export function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /does not exist|42P01|schema cache|Could not find the (table|function)/i.test(msg);
}

/** A full-length reply, reserved up front against the cap. */
export const RESERVED_REPLY_CHARS = 4_000;

export type SpendReservation =
  | { ok: true; reservationId: string; settle: (replyChars: number) => Promise<void> }
  | { ok: false; message: string };

/** The refusal `message` is unprefixed; the caller sends it under the bot's own name. */
export async function reserveModelSpend(
  store: BotTeamStore | null | undefined,
  botSlug: BotSlug,
  inputChars: number,
): Promise<SpendReservation> {
  if (!store) {
    return {
      ok: false,
      message: `The bot team's database isn't connected on the server (TELEGRAM_COMPANY_ID / Supabase keys), so I can't check the spending cap and I won't call the model until I can. Nothing was sent anywhere.`,
    };
  }
  let reservationId: string | null;
  try {
    reservationId = await store.reserveSpend({
      botSlug,
      model: modelForTier("scan"),
      tier: "scan",
      estimatedCents: estimateCallCostCents({ tier: "scan", inputChars, outputChars: RESERVED_REPLY_CHARS }),
      capCents: monthlyCapCents(),
      sinceIso: monthStartIso(),
    });
  } catch (err) {
    console.error(`[bot-team] ${botSlug} spend reservation failed — refusing the model call`, err);
    // Say WHY - a missing table/function is setup, not "try again in a moment".
    return {
      ok: false,
      message: isMissingTableError(err)
        ? `The bot team's database isn't set up on the server yet (migrations 00103 and 00109 — King applies them), so I can't check the spending cap and I won't call the model until I can. Nothing was sent anywhere.`
        : `I couldn't check the spending cap, so I'm not calling the model on this one. Try again in a moment.`,
    };
  }
  if (!reservationId) return { ok: false, message: SPEND_CAP_REACHED_TEXT };
  const id = reservationId;
  return {
    ok: true,
    reservationId: id,
    settle: async (replyChars) => {
      try {
        await store.settleSpend(id, estimateCallCostCents({ tier: "scan", inputChars, outputChars: replyChars }));
      } catch (err) {
        // The full reservation stays on the ledger: the cap errs high, never low.
        console.error(`[bot-team] ${botSlug} spend settle failed`, err);
      }
    },
  };
}
