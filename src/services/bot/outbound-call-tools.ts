// Abel's outbound-call tools (docs/design/outbound-calling.md).
// `place_call` is a WRITE that is ALWAYS proposed first: a phone call to
// a third party can't be unsaid, so it sits in the same always-propose
// class as the dump-staging writes. One tap on Yes dials. The call goes
// out only to a number the app already knows (driver, broker, customer),
// and only when the `outbound_calling` capability is switched on.

import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import {
  formatCallTime,
  formatPhoneForDisplay,
  normalizeUsPhone,
} from "@/lib/outbound-calling";
import {
  getCallingConfig,
  isOutboundCallingConfigured,
  missingCallingSetup,
  OUTBOUND_CALLING_CAPABILITY,
  type CallingConfig,
} from "@/services/calling/config";
import { dialOutboundCallRow } from "@/services/calling/dialer";
import { resolveKnownNumber } from "@/services/calling/known-numbers";
import {
  claimNextOutboundCall,
  enqueueOutboundCall,
  listOutboundCalls,
} from "@/services/calling/queue";
import type { FetchImpl } from "@/services/calling/telnyx";

export interface OutboundCallToolDeps {
  config?: CallingConfig;
  fetchImpl?: FetchImpl;
}

const MAX_PURPOSE_CHARS = 500;
const MAX_SAY_CHARS = 2000;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The kill switch, read live: global off, or no `outbound_calling` row, means off. */
async function isCallingAllowed(
  store: BotBrainStore,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { client, companyId } = store;
  try {
    const [companyRes, capRes] = await Promise.all([
      client.from("companies").select("ai_globally_disabled").eq("id", companyId).single(),
      client
        .from("ai_capability_settings")
        .select("enabled")
        .eq("company_id", companyId)
        .eq("capability", OUTBOUND_CALLING_CAPABILITY)
        .maybeSingle(),
    ]);
    if (companyRes.error) return { ok: false, error: "I couldn't check whether calling is switched on." };
    if ((companyRes.data as { ai_globally_disabled?: boolean } | null)?.ai_globally_disabled) {
      return { ok: false, error: "All AI capabilities are switched off, so I can't call." };
    }
    if (capRes.error) return { ok: false, error: "I couldn't check whether calling is switched on." };
    if ((capRes.data as { enabled?: boolean } | null)?.enabled !== true) {
      return {
        ok: false,
        error: "Outbound calling is switched off. Switch it on in Settings → Abel and AI first.",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "I couldn't check whether calling is switched on." };
  }
}

export function buildOutboundCallTools(store: BotBrainStore, deps: OutboundCallToolDeps = {}): AgentTool[] {
  const { client, companyId } = store;
  const config = deps.config ?? getCallingConfig();
  const fetchImpl = deps.fetchImpl;

  const placeCall: AgentTool = {
    name: "place_call",
    description:
      "Call someone on the phone, from the one shared company number, and talk with them like a person: the assistant greets them, gets across what it needs to, listens to the answer, and repeats it back. Use when someone is driving and can't answer a text, or when a call settles something a message can't - an ETA check, a delivery confirmation, a dock question. to_phone must be a number the app already knows (a driver, broker, or customer on file). The call is ALWAYS proposed first: it only goes out when the owner says yes. purpose is one line on why; say is what Abel has to get across, in plain words.",
    parameters: {
      type: "object",
      properties: {
        to_phone: { type: "string", description: "The phone number to call, as stored or spoken." },
        purpose: { type: "string", description: "One line on why: 'ETA check on Trip 1903', 'delivery confirmation'." },
        say: { type: "string", description: "What Abel has to get across on the call, in plain words." },
      },
      required: ["to_phone", "purpose", "say"],
    },
    access: "write",
    alwaysPropose: true,
    validateArgs(args) {
      const phone = normalizeUsPhone(asString(args.to_phone));
      if (!phone) return { ok: false, error: `"${asString(args.to_phone)}" isn't a US phone number I can dial.` };
      const purpose = asString(args.purpose).trim();
      if (!purpose) return { ok: false, error: "Say why the call is happening (one line)." };
      if (purpose.length > MAX_PURPOSE_CHARS) return { ok: false, error: "Keep the purpose to one line." };
      const say = asString(args.say).trim();
      if (!say) return { ok: false, error: "Say what Abel has to get across on the call." };
      if (say.length > MAX_SAY_CHARS) return { ok: false, error: "Keep what Abel has to say under 2,000 characters." };
      return { ok: true, args: { ...args, to_phone: phone, purpose, say } };
    },
    async verifyProposal(args) {
      const allowed = await isCallingAllowed(store);
      if (!allowed.ok) return allowed;
      if (!isOutboundCallingConfigured(config)) {
        return { ok: false, error: `Outbound calling isn't set up yet — ${missingCallingSetup(config) ?? "the Telnyx number isn't connected"}.` };
      }
      const phone = normalizeUsPhone(asString(args.to_phone));
      if (!phone) return { ok: false, error: `"${asString(args.to_phone)}" isn't a US phone number I can dial.` };
      let known;
      try {
        known = await resolveKnownNumber(client, companyId, phone);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "I couldn't check that number." };
      }
      if (!known) {
        return {
          ok: false,
          error: `I don't have ${formatPhoneForDisplay(phone)} on file — I only call drivers, brokers, and customers already in the app.`,
        };
      }
      return {
        ok: true,
        summary: `Call ${known.name} (${known.kind}) at ${formatPhoneForDisplay(phone)} — ${asString(args.purpose).trim()}`,
      };
    },
    summarize(args) {
      return `Call ${formatPhoneForDisplay(normalizeUsPhone(asString(args.to_phone)) ?? asString(args.to_phone))} — ${asString(args.purpose).trim()}`;
    },
    async run(args) {
      const allowed = await isCallingAllowed(store);
      if (!allowed.ok) return allowed.error;
      if (!isOutboundCallingConfigured(config)) {
        return `Outbound calling isn't set up yet — ${missingCallingSetup(config) ?? "the Telnyx number isn't connected"}. Nothing was dialed.`;
      }
      const phone = normalizeUsPhone(asString(args.to_phone));
      const purpose = asString(args.purpose).trim();
      const say = asString(args.say).trim();
      if (!phone || !purpose || !say) return "That call is missing the number, the purpose, or what to say — nothing was dialed.";
      let known;
      try {
        known = await resolveKnownNumber(client, companyId, phone);
      } catch (err) {
        return err instanceof Error ? err.message : "I couldn't check that number — nothing was dialed.";
      }
      if (!known) {
        return `I don't have ${formatPhoneForDisplay(phone)} on file — I only call drivers, brokers, and customers already in the app. Nothing was dialed.`;
      }
      let row;
      try {
        row = await enqueueOutboundCall(client, companyId, {
          toNumber: phone,
          toName: known.name,
          purpose,
          say,
        });
      } catch (err) {
        return err instanceof Error ? err.message : "I couldn't queue the call.";
      }
      let claimed;
      try {
        claimed = await claimNextOutboundCall(client, companyId);
      } catch (err) {
        return err instanceof Error ? err.message : "I couldn't check the call queue.";
      }
      if (!claimed || claimed.id !== row.id) {
        return (
          `Queued the call to ${known.name} (${formatPhoneForDisplay(phone)}) — another call is in progress, ` +
          `so this one goes next on the shared number. I'll say when it goes out.`
        );
      }
      const dialed = await dialOutboundCallRow(client, claimed, { config, fetchImpl });
      if (!dialed.ok) return `The call to ${known.name} didn't go out: ${dialed.error}`;
      return (
        `Calling ${known.name} (${formatPhoneForDisplay(phone)}) now from the company number — ` +
        `about ${purpose}. I'll write down what they say when the call ends.`
      );
    },
  };

  const listCalls: AgentTool = {
    name: "list_outbound_calls",
    description:
      "Calls Abel has placed, queued, or finished - who, when, what about, and what came of it (answered, voicemail, no answer, what they confirmed). Use for 'did you call them', 'what did they say', and 'what calls went out today'.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many recent calls (default 5, max 20)." },
      },
    },
    access: "read",
    async run(args) {
      const limit = typeof args.limit === "number" ? args.limit : 5;
      let rows;
      try {
        rows = await listOutboundCalls(client, companyId, limit);
      } catch (err) {
        return err instanceof Error ? err.message : "I couldn't list the calls.";
      }
      if (rows.length === 0) return "No calls yet.";
      return rows
        .map((row) => {
          const when = formatCallTime(row.created_at);
          const outcome = row.outcome ? ` — ${row.outcome}` : "";
          const transcript = row.transcript ? `\n  What they said: ${row.transcript.slice(0, 500)}` : "";
          return `• ${when} — ${row.to_name} (${formatPhoneForDisplay(row.to_number)}): ${row.status}, ${row.purpose}${outcome}${transcript}`;
        })
        .join("\n");
    },
  };

  return [placeCall, listCalls];
}
