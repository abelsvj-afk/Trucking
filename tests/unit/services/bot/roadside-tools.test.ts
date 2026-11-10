// Roadside inspection tools (docs/design/eld-roadside-overlay.md):
// prepare files the packet + stages a standalone owner@ draft and sends
// NOTHING; send_inspection_packet is always a proposal and, on the yes,
// sends the exact approved text as body AND attachment through
// sendApprovedDraft; send_inspection_packet_to_me drops the filed packet
// into the owner's Telegram chat. A standalone draft must never leak into
// the email-reply send path.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildRoadsideTools } from "@/services/bot/roadside-tools";
import { prepareEmailSendProposal } from "@/services/bot/email-tools";
import { bodyFingerprint, sendApprovedDraft, type SendDeps } from "@/services/email/send";
import type { BotBrainStore } from "@/services/bot/store";
import { memStore } from "../../../helpers/mem-email-store";

const ENV = { IONOS_EMAIL_OWNER_USER: "owner@roadtolegacytrucking.com", IONOS_EMAIL_OWNER_PASSWORD: "pw-owner", IONOS_EMAIL_DISPATCH_USER: "dispatch@roadtolegacytrucking.com", IONOS_EMAIL_DISPATCH_PASSWORD: "pw-dispatch" };
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Row = Record<string, unknown>;

/** A minimal chainable fake for exactly the queries the packet service makes. */
function fakeClient() {
  const now = Date.now();
  const dutyRows = [
    { duty_status: "off_duty", started_at: iso(now - 30 * H) },
    { duty_status: "on_duty", started_at: iso(now - 4 * H) },
    { duty_status: "driving", started_at: iso(now - 3 * H), location: "Panama City, FL" },
  ];
  const db = { packets: [] as Row[], documents: [] as Row[] };
  let seq = 0;

  class Builder {
    pendingInsert: Row | null = null;
    constructor(private table: string) {}
    select() { return this; }
    insert(obj: Row) { this.pendingInsert = obj; return this; }
    update() { return this; }
    delete() { return this; }
    eq() { return this; }
    is() { return this; }
    gte() { return this; }
    order() { return this; }
    limit() { return this; }
    async single() {
      const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, ...(this.pendingInsert ?? {}) };
      if (this.table === "roadside_packets") db.packets.push(row);
      if (this.table === "documents") db.documents.push(row);
      return { data: row, error: null };
    }
    async maybeSingle() {
      if (this.table === "companies") return { data: { name: "Test Trucking LLC" }, error: null };
      if (this.table === "roadside_packets") return { data: db.packets[db.packets.length - 1] ?? null, error: null };
      return { data: null, error: null };
    }
    then<TResult1 = { data: unknown; error: null }, TResult2 = never>(onF: (v: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>, onR?: ((r: unknown) => TResult2 | PromiseLike<TResult2>) | null) {
      const value = this.table === "duty_logs" ? { data: dutyRows, error: null as null }
        : this.table === "drivers" ? { data: [{ name: "Test Driver", role: "owner_operator", created_at: iso(now - 90 * 24 * H) }], error: null as null }
        : { data: [], error: null as null };
      return Promise.resolve(value).then(onF, onR ?? undefined);
    }
  }

  const client = {
    from: (table: string) => new Builder(table),
    rpc: async () => ({ data: null, error: { message: "rpc unavailable in test" } }),
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
  } as unknown as SupabaseClient;
  return { client, db };
}

function setup() {
  const { client, db } = fakeClient();
  const store = { client, companyId: "company-1", channel: "telegram" } as unknown as BotBrainStore;
  const emailStore = memStore();
  const delivered: { envelope: { from: string; to: string }; raw: Buffer }[] = [];
  const telegramDocs: { fileName: string; text: string }[] = [];
  const sendDeps: Partial<SendDeps> = {
    env: ENV,
    deliver: vi.fn(async (_c, _s, envelope, raw) => { delivered.push({ envelope, raw }); }),
    appendSent: vi.fn(async () => true),
  };
  const tools = buildRoadsideTools(store, emailStore, {
    sendDeps,
    sendTelegram: async (doc) => { telegramDocs.push({ fileName: doc.fileName, text: doc.text }); return true; },
  });
  const byName = (n: string) => tools.find((t) => t.name === n)!;
  return { store, emailStore, delivered, telegramDocs, db, byName };
}

describe("prepare_inspection_packet", () => {
  it("files the packet, stages a standalone owner@ draft, and sends nothing", async () => {
    const s = setup();
    const out = await s.byName("prepare_inspection_packet").run({ officer_email: "officer@example.gov" });
    expect(out).toContain("NOT sent");
    expect(out).toContain("officer@example.gov");
    expect(out).toContain("CONVENIENCE COPY");
    expect(s.delivered).toHaveLength(0);
    expect(s.db.packets).toHaveLength(1);
    expect(s.db.documents).toHaveLength(1);
    const draft = s.emailStore.drafts[0]!;
    expect(draft.emailMessageId).toBeNull();
    expect(draft.mailbox).toBe("owner");
    expect(draft.toAddress).toBe("officer@example.gov");
    expect(out).toContain(bodyFingerprint(draft.body));
  });

  it("refuses a malformed officer address before building anything", async () => {
    const s = setup();
    const v = s.byName("prepare_inspection_packet").validateArgs?.({ officer_email: "not an address" });
    expect(v?.ok).toBe(false);
    expect(s.db.packets).toHaveLength(0);
  });
});

describe("send_inspection_packet", () => {
  async function staged() {
    const s = setup();
    await s.byName("prepare_inspection_packet").run({ officer_email: "officer@example.gov" });
    const draft = s.emailStore.drafts[0]!;
    return { s, draft, fingerprint: bodyFingerprint(draft.body) };
  }

  it("the proposal summary is generated from the stored draft (recipient + full packet)", async () => {
    const { s, draft, fingerprint } = await staged();
    const v = await s.byName("send_inspection_packet").verifyProposal!({ draft_id: draft.id, fingerprint });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.summary).toContain("officer@example.gov");
      expect(v.summary).toContain("ROADSIDE INSPECTION PACKET");
    }
    const wrong = await s.byName("send_inspection_packet").verifyProposal!({ draft_id: draft.id, fingerprint: "000000000000" });
    expect(wrong.ok).toBe(false);
  });

  it("on the yes: sends once from owner@, packet as body AND attachment, and files the outcome", async () => {
    const { s, draft, fingerprint } = await staged();
    const out = await s.byName("send_inspection_packet").run({ draft_id: draft.id, fingerprint });
    expect(out).toMatch(/^SENT from /);
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0]!.envelope).toEqual({ from: "owner@roadtolegacytrucking.com", to: "officer@example.gov" });
    const raw = s.delivered[0]!.raw.toString("utf8");
    expect(raw).toContain("inspection-packet.txt");
    expect(raw).toContain("ROADSIDE INSPECTION PACKET");
    const sentRow = s.emailStore.sent[0]!;
    expect(sentRow.emailMessageId).toBeNull();
    expect(sentRow.mailbox).toBe("owner");
    expect(s.db.packets[0]!.sent_to ?? "officer@example.gov").toBe("officer@example.gov");
  });

  it("a changed packet cannot ride the old approval", async () => {
    const { s, draft, fingerprint } = await staged();
    await s.emailStore.updateDraftBody(draft.id, `${draft.body}\nEdited after approval.`);
    const out = await s.byName("send_inspection_packet").run({ draft_id: draft.id, fingerprint });
    expect(out).toMatch(/^NOT SENT/);
    expect(s.delivered).toHaveLength(0);
  });
});

describe("sendApprovedDraft standalone guards", () => {
  it("an attachment that differs from the approved body blocks the send", async () => {
    const emailStore = memStore();
    const draft = await emailStore.createStandaloneDraft("officer@example.gov", "Packet", "THE APPROVED PACKET TEXT", "owner");
    const delivered: Buffer[] = [];
    const deps: SendDeps = {
      emailStore, now: () => new Date(), env: ENV,
      deliver: async (_c, _s, _e, raw) => { delivered.push(raw); },
      appendSent: async () => true,
    };
    const bad = await sendApprovedDraft(deps, { draftId: draft.id, approvedFingerprint: bodyFingerprint(draft.body), attachments: [{ fileName: "inspection-packet.txt", contentType: "text/plain", text: "SOMETHING ELSE" }] });
    expect(bad.ok).toBe(false);
    expect(delivered).toHaveLength(0);
    const good = await sendApprovedDraft(deps, { draftId: draft.id, approvedFingerprint: bodyFingerprint(draft.body), attachments: [{ fileName: "inspection-packet.txt", contentType: "text/plain", text: draft.body }] });
    expect(good.ok).toBe(true);
    expect(good.ok && good.sent.emailMessageId).toBeNull();
  });

  it("a standalone draft addressed from dispatch@ is refused outright", async () => {
    const emailStore = memStore();
    const draft = await emailStore.createStandaloneDraft("officer@example.gov", "Packet", "TEXT", "dispatch");
    const deps: SendDeps = { emailStore, now: () => new Date(), env: { ...ENV, EMAIL_SEND_DISPATCH_ENABLED: "true" }, deliver: async () => undefined, appendSent: async () => true };
    const r = await sendApprovedDraft(deps, { draftId: draft.id, approvedFingerprint: bodyFingerprint(draft.body) });
    expect(r.ok).toBe(false);
  });
});

describe("send_inspection_packet_to_me", () => {
  it("builds + files when nothing is filed, then drops the packet file into the chat", async () => {
    const s = setup();
    const v = await s.byName("send_inspection_packet_to_me").verifyProposal!({});
    expect(v.ok).toBe(true);
    const out = await s.byName("send_inspection_packet_to_me").run({});
    expect(out).toMatch(/^Sent/);
    expect(s.telegramDocs).toHaveLength(1);
    expect(s.telegramDocs[0]!.text).toContain("CONVENIENCE COPY");
    expect(s.db.packets).toHaveLength(1);
    // Second time it reuses the filed packet instead of filing another.
    await s.byName("send_inspection_packet_to_me").run({});
    expect(s.telegramDocs).toHaveLength(2);
    expect(s.db.packets).toHaveLength(1);
  });
});

describe("standalone drafts stay out of the reply path", () => {
  it("prepareEmailSendProposal ignores a standalone roadside draft", async () => {
    const s = setup();
    await s.emailStore.createStandaloneDraft("officer@example.gov", "Packet", "TEXT", "owner");
    const proposal = await prepareEmailSendProposal(s.store, s.emailStore);
    expect(proposal).toBeNull();
  });
});
