// Abel's roadside inspection tools (docs/design/eld-roadside-overlay.md;
// owner spec 2026-11-09). The roadside flow, deliberately as short as the
// proven email flow:
//
//   prepare_inspection_packet  (immediate when named) - builds the packet
//     from the one HOS read, files it, saves it as a standalone owner@
//     draft, and shows him the officer's address + the exact packet +
//     its fingerprint. Nothing is sent.
//   send_inspection_packet     (ALWAYS a proposal) - his one YES sends
//     exactly that text, as the email body AND as the attached packet
//     file, through sendApprovedDraft - which re-checks the fingerprint
//     itself, so a changed packet can never ride an old approval.
//   send_inspection_packet_to_me (ALWAYS a proposal) - drops the filed
//     packet into THIS Telegram chat as a file so he can show his screen.
//
// The packet is a convenience copy of his app-logged hours; the carrier's
// ELD / his paper log is the legal record, and the packet says so itself.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { createEmailStore, type EmailStore } from "@/services/email/store";
import { bodyFingerprint, FINGERPRINT_LENGTH, sendApprovedDraft, SINGLE_ADDRESS, type SendDeps } from "@/services/email/send";
import { MAILBOX_LABEL } from "@/services/email/config";
import { createTelegramNotifier } from "@/services/telegram/notify";
import { sendTelegramDocument } from "@/services/telegram/send-document";
import { buildLivePacket, filePacket, latestFiledPacket, markPacketEmailed, markPacketTelegrammed } from "@/services/roadside/packet-service";

const uuid = z.string().uuid();
const prepareSchema = z.object({
  officer_email: z.string().trim().toLowerCase().max(254).refine((v) => SINGLE_ADDRESS.test(v), "the officer's email must be one plain email address"),
});
const sendSchema = z.object({
  draft_id: uuid,
  fingerprint: z.string().trim().toLowerCase().regex(new RegExp(`^[0-9a-f]{${FINGERPRINT_LENGTH}}$`), "fingerprint must be the 12-character code shown with the packet"),
});

/** True when the database is still missing migration 00086 - said in plain words, never dressed as a send/file failure of another kind. */
const preMigration = (err: unknown): boolean => /does not exist|roadside_packets|mailbox/i.test(err instanceof Error ? err.message : String(err));
const DB_STEP_NOTE = "The roadside database step (migration 00086) is not applied on the live database yet, so I can't file or send the packet from here yet. The packet itself is ready - you can open Roadside inspection in the app to show it on screen.";

export interface RoadsideToolDeps {
  sendDeps?: Partial<SendDeps>;
  sendTelegram?: typeof sendTelegramDocument;
}

export function buildRoadsideTools(store: BotBrainStore, emailStore: EmailStore = createEmailStore(store.client, store.companyId), deps: RoadsideToolDeps = {}): AgentTool[] {
  const send = (): SendDeps => ({
    emailStore,
    now: () => new Date(),
    notify: (text) => createTelegramNotifier().notifyOwner(text),
    ...(deps.sendDeps ?? {}),
  });
  const telegram = deps.sendTelegram ?? sendTelegramDocument;

  return [
    {
      name: "prepare_inspection_packet",
      description:
        "Build the roadside inspection packet (his logged hours for today + the previous 7 days, from the same HOS read everything else uses) for a DOT officer, file it, and save it as a ready-to-send email from owner@ to the officer's email address he gives you. Shows him the recipient and the EXACT packet text with its fingerprint. This does NOT send anything - sending is send_inspection_packet, which needs his yes. The packet is a convenience copy; it states plainly that the carrier ELD / his paper log is the legal record. Use when he says things like 'send the officer my logs', 'email this to the officer', or gives you an officer's email at a stop.",
      parameters: {
        type: "object",
        properties: { officer_email: { type: "string", description: "The officer's email address, exactly as he gave it." } },
        required: ["officer_email"],
      },
      access: "write",
      immediateWhenNamed: true,
      validateArgs(args) {
        const p = prepareSchema.safeParse(args);
        return p.success ? { ok: true as const, args: p.data } : { ok: false as const, error: p.error.issues[0]?.message ?? "invalid arguments" };
      },
      summarize: (args) => `Prepare the inspection packet for ${String(args.officer_email ?? "")} (not sent)`,
      async run(args) {
        const p = prepareSchema.safeParse(args);
        if (!p.success) return `Packet not prepared: ${p.error.issues[0]?.message ?? "invalid arguments"}`;
        const packet = await buildLivePacket(store.client, store.companyId);
        try {
          await filePacket(store.client, store.companyId, packet);
        } catch (err) {
          if (preMigration(err)) return `I built the packet, but I couldn't file it. ${DB_STEP_NOTE}`;
          return `I built the packet, but filing it failed (${err instanceof Error ? err.message : "unknown error"}). Nothing was staged or sent.`;
        }
        let draft;
        try {
          draft = await emailStore.createStandaloneDraft(p.data.officer_email, packet.subject, packet.text, "owner");
        } catch (err) {
          if (preMigration(err)) return `The packet is built and filed, but I couldn't stage the email. ${DB_STEP_NOTE}`;
          return `The packet is built and filed, but staging the email failed (${err instanceof Error ? err.message : "unknown error"}). Nothing was sent.`;
        }
        return [
          `Inspection packet ready - NOT sent. It will go from ${MAILBOX_LABEL.owner} to ${draft.toAddress} when you say yes.`,
          `Subject: ${draft.subject}`,
          `Packet fingerprint: ${bodyFingerprint(draft.body)} (draft ${draft.id})`,
          "--- PACKET START ---",
          draft.body,
          "--- PACKET END ---",
          "If that address is right, say send it and I'll stage the one-tap confirmation. Or say 'send it to me here' and I'll drop the file in this chat instead.",
        ].join("\n");
      },
    },
    {
      name: "send_inspection_packet",
      description:
        "EMAIL the prepared inspection packet to the officer. ALWAYS a proposal: it shows him the officer's address and the exact packet, and sends only on his YES. Pass the draft id and 12-character fingerprint exactly as prepare_inspection_packet showed them - if the packet changed since, the send is refused. Sends from owner@ only, with the packet attached as a file as well as in the body.",
      parameters: {
        type: "object",
        properties: { draft_id: { type: "string" }, fingerprint: { type: "string", description: "The 12-character fingerprint shown with the packet." } },
        required: ["draft_id", "fingerprint"],
      },
      access: "write",
      alwaysPropose: true,
      validateArgs(args) {
        const p = sendSchema.safeParse(args);
        return p.success ? { ok: true as const, args: p.data } : { ok: false as const, error: p.error.issues[0]?.message ?? "invalid arguments" };
      },
      // The proposal text the owner approves is generated HERE, from the stored draft - never from model text.
      async verifyProposal(args) {
        const p = sendSchema.safeParse(args);
        if (!p.success) return { ok: false as const, error: p.error.issues[0]?.message ?? "invalid arguments" };
        const d = await emailStore.getDraft(p.data.draft_id);
        if (!d) return { ok: false as const, error: "That packet draft doesn't exist - prepare the packet first" };
        if (d.emailMessageId !== null) return { ok: false as const, error: "That draft is an email reply, not an inspection packet - use send_email for it" };
        if (d.status === "sent") return { ok: false as const, error: "That packet was already sent" };
        if (d.status !== "draft" && d.status !== "failed") return { ok: false as const, error: `That packet draft is ${d.status}` };
        if (bodyFingerprint(d.body) !== p.data.fingerprint) return { ok: false as const, error: "The packet text is not what that fingerprint covers (it was rebuilt). Prepare it again and use the new fingerprint" };
        return {
          ok: true as const,
          summary: `EMAIL the inspection packet from ${MAILBOX_LABEL.owner} - To: ${d.toAddress} - Subject: ${d.subject} - the packet file is attached and the same text is in the body: """${d.body}""" (draft ${d.id}, fingerprint ${bodyFingerprint(d.body)})`,
        };
      },
      summarize: (args) => `Email the inspection packet (draft ${String(args.draft_id ?? "")}, fingerprint ${String(args.fingerprint ?? "")})`,
      async run(args) {
        const p = sendSchema.safeParse(args);
        if (!p.success) return `Not sent: ${p.error.issues[0]?.message ?? "invalid arguments"}`;
        const draft = await emailStore.getDraft(p.data.draft_id);
        if (!draft) return "Not sent: that packet draft doesn't exist anymore.";
        const result = await sendApprovedDraft(send(), {
          draftId: p.data.draft_id,
          approvedFingerprint: p.data.fingerprint,
          attachments: [{ fileName: "inspection-packet.txt", contentType: "text/plain", text: draft.body }],
        });
        if (!result.ok) return `NOT SENT: ${result.reason}`;
        // File the outcome back onto the packet record (best effort - the send already happened and is recorded in email_sent).
        try {
          const { data } = await store.client
            .from("roadside_packets")
            .select("id")
            .eq("company_id", store.companyId)
            .eq("body", draft.body)
            .is("deleted_at", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (data) await markPacketEmailed(store.client, store.companyId, String((data as { id: string }).id), result.sent.toAddress, result.sent.id || null);
        } catch { /* the send stands; the packet row update is bookkeeping */ }
        return `SENT from ${MAILBOX_LABEL.owner} to ${result.sent.toAddress}, subject "${result.sent.subject}", packet attached.${result.warning ? ` Note: ${result.warning}` : " A copy is in the Sent folder."}`;
      },
    },
    {
      name: "send_inspection_packet_to_me",
      description:
        "Send the inspection packet as a FILE into this Telegram chat so he can show it on his phone screen at the roadside. Uses the most recently filed packet; if none is filed yet, builds and files the current one first. ALWAYS a proposal - it sends on his yes. Use when he says 'give me the packet', 'send my logs here', or wants to show an officer his screen instead of emailing.",
      parameters: { type: "object", properties: {}, required: [] },
      access: "write",
      alwaysPropose: true,
      validateArgs() {
        return { ok: true as const, args: {} };
      },
      async verifyProposal() {
        const filed = await latestFiledPacket(store.client, store.companyId).catch(() => null);
        return {
          ok: true as const,
          summary: filed
            ? `Send the filed inspection packet (covering ${filed.packet.periodStart} to ${filed.packet.periodEnd}) into THIS Telegram chat as a file, for showing on screen. It is a convenience copy - the carrier ELD / paper log is the legal record.`
            : "Build the current inspection packet (today + the previous 7 days), file it, and send it into THIS Telegram chat as a file, for showing on screen. It is a convenience copy - the carrier ELD / paper log is the legal record.",
        };
      },
      summarize: () => "Send the inspection packet file into this Telegram chat",
      async run() {
        let filed = await latestFiledPacket(store.client, store.companyId).catch(() => null);
        if (!filed) {
          const packet = await buildLivePacket(store.client, store.companyId);
          try {
            const f = await filePacket(store.client, store.companyId, packet);
            filed = { id: f.packetId, packet };
          } catch (err) {
            if (preMigration(err)) return `I built the packet, but I couldn't file it. ${DB_STEP_NOTE}`;
            return `I built the packet, but filing it failed (${err instanceof Error ? err.message : "unknown error"}). Nothing was sent.`;
          }
        }
        const ok = await telegram({
          fileName: filed.packet.fileName,
          contentType: "text/plain",
          text: filed.packet.text,
          caption: "Inspection packet - convenience copy. The carrier ELD / your paper log is the legal record.",
        });
        if (!ok) return "I couldn't deliver the packet file to this chat (Telegram didn't accept it). Nothing was sent - open Roadside inspection in the app to show it on screen instead.";
        await markPacketTelegrammed(store.client, store.companyId, filed.id).catch(() => undefined);
        return `Sent - the packet file is in this chat (covering ${filed.packet.periodStart} to ${filed.packet.periodEnd}). Show the officer your screen, or open Roadside inspection in the app for the big-print version. Reminder it states itself: convenience copy, your carrier ELD / paper log is the legal record.`;
      },
    },
  ];
}
