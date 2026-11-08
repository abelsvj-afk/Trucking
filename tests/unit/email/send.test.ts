import { describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { bodyFingerprint, bodyHash, buildOutgoing, isThreadable, sendApprovedDraft, SINGLE_ADDRESS, type SendDeps } from "@/services/email/send";
import { getEmailConfig, getSmtpSettings, isSendEnabled } from "@/services/email/config";
import { classifySmtpError } from "@/services/email/errors";
import { buildEmailTools } from "@/services/bot/email-tools";
import { composeMessageAlert } from "@/services/email/ingest";
import { memStore } from "../../helpers/mem-email-store";

const ENV = { IONOS_EMAIL_OWNER_USER: "owner@roadtolegacytrucking.com", IONOS_EMAIL_OWNER_PASSWORD: "pw-owner", IONOS_EMAIL_DISPATCH_USER: "dispatch@roadtolegacytrucking.com", IONOS_EMAIL_DISPATCH_PASSWORD: "pw-dispatch" };
const NOW = new Date("2026-11-08T15:00:00Z");

async function setup(opts: { mailbox?: "owner" | "dispatch"; messageId?: string; env?: Record<string, string | undefined> } = {}) {
  const store = memStore();
  const mailbox = opts.mailbox ?? "owner";
  const msgId = opts.messageId ?? "<orig-123@broker.example>";
  const { id } = await store.insertMessage(mailbox, { messageId: msgId, fromAddress: "bob@broker.example", fromName: "Bob", replyTo: null, toAddresses: null, subject: "Load question", receivedAt: NOW.toISOString(), bodyText: "hi", attachments: [] }, 1, "1");
  const draft = await store.createDraft(id, "bob@broker.example", "Re: Load question", "Thanks Bob - yes, I can cover that.");
  const delivered: { envelope: { from: string; to: string }; raw: Buffer }[] = [];
  const deps: SendDeps & { delivered: typeof delivered; appended: Buffer[]; notified: string[] } = {
    emailStore: store, now: () => NOW, env: opts.env ?? ENV, delivered, appended: [], notified: [],
    deliver: vi.fn(async (_c, _s, envelope, raw) => { delivered.push({ envelope, raw }); }),
    appendSent: vi.fn(async (_c, raw) => { deps.appended.push(raw); return true; }),
    notify: vi.fn(async (t: string) => { deps.notified.push(t); return true; }),
  };
  return { store, draft, original: id, deps };
}

describe("sending: the approval gate", () => {
  it("(a) dispatch@ is refused while the flag is off, and works when it is switched on", async () => {
    const off = await setup({ mailbox: "dispatch" });
    const r = await sendApprovedDraft(off.deps, { draftId: off.draft.id, approvedFingerprint: bodyFingerprint(off.draft.body) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/Dispatch sending isn't switched on/);
    expect(off.deps.delivered).toHaveLength(0);
    expect(off.store.drafts[0]!.status).toBe("draft"); // untouched, still a draft
    expect(isSendEnabled("dispatch", {})).toBe(false);
    expect(isSendEnabled("dispatch", { EMAIL_SEND_DISPATCH_ENABLED: "false" })).toBe(false);
    expect(isSendEnabled("owner", {})).toBe(true);

    const on = await setup({ mailbox: "dispatch", env: { ...ENV, EMAIL_SEND_DISPATCH_ENABLED: "true" } });
    const ok = await sendApprovedDraft(on.deps, { draftId: on.draft.id, approvedFingerprint: bodyFingerprint(on.draft.body) });
    expect(ok.ok).toBe(true);
    expect(on.deps.delivered[0]!.envelope.from).toBe("dispatch@roadtolegacytrucking.com");
  });

  it("(b) refuses without a real, open draft: missing, already sent, discarded", async () => {
    const t = await setup();
    const fp = bodyFingerprint(t.draft.body);
    expect((await sendApprovedDraft(t.deps, { draftId: "00000000-0000-4000-8000-000000000999", approvedFingerprint: fp })).ok).toBe(false);
    expect((await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: "short" })).ok).toBe(false);
    expect((await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: "000000000000" })).ok).toBe(false);
    expect(t.deps.delivered).toHaveLength(0);
    expect((await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: fp })).ok).toBe(true);
    const again = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: fp });
    expect(!again.ok && again.reason).toMatch(/already sent/);
    expect(t.deps.delivered).toHaveLength(1); // never twice
    const d = await setup();
    d.store.drafts[0]!.status = "discarded";
    expect((await sendApprovedDraft(d.deps, { draftId: d.draft.id, approvedFingerprint: bodyFingerprint(d.draft.body) })).ok).toBe(false);
  });

  it("(c) an edit after approval blocks the send and needs a fresh approval", async () => {
    const t = await setup();
    const approved = bodyFingerprint(t.draft.body);
    await t.store.updateDraftBody(t.draft.id, "Actually, I can't cover that. Sorry.");
    const r = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: approved });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/changed after you approved/);
    expect(t.deps.delivered).toHaveLength(0);
    // approving the NEW text works
    const fresh = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint("Actually, I can't cover that. Sorry.") });
    expect(fresh.ok).toBe(true);
  });

  it("a double yes cannot send twice (atomic claim)", async () => {
    const t = await setup();
    const fp = bodyFingerprint(t.draft.body);
    const [a, b] = await Promise.all([sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: fp }), sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: fp })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(t.deps.delivered).toHaveLength(1);
  });

  it("only one plain recipient is ever accepted (no list, Cc-style or header tricks)", async () => {
    for (const bad of ["a@b.com, c@d.com", "a@b.com\nBcc: x@y.com", "Bob <a@b.com>", "a@b.com;c@d.com", "nobody"]) {
      expect(SINGLE_ADDRESS.test(bad), bad).toBe(false);
      const t = await setup();
      t.store.drafts[0]!.toAddress = bad;
      const r = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint(t.draft.body) });
      expect(r.ok).toBe(false);
      expect(t.deps.delivered).toHaveLength(0);
    }
    expect(SINGLE_ADDRESS.test("bob@broker.example")).toBe(true);
  });
});

describe("(d) the reply threads", () => {
  it("carries Re:, In-Reply-To, References, its own Message-ID, the right From/To - and exactly one recipient", async () => {
    const t = await setup();
    const r = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint(t.draft.body) });
    expect(r.ok).toBe(true);
    const mail = await simpleParser(t.deps.delivered[0]!.raw);
    expect(mail.subject).toBe("Re: Load question");
    expect(mail.inReplyTo).toBe("<orig-123@broker.example>");
    expect([mail.references].flat()).toEqual(["<orig-123@broker.example>"]);
    expect(mail.messageId).toMatch(/^<[0-9a-f-]{36}@roadtolegacytrucking\.com>$/);
    expect(mail.from?.value[0]?.address).toBe("owner@roadtolegacytrucking.com");
    expect(mail.to).toBeDefined();
    expect((Array.isArray(mail.to) ? mail.to[0] : mail.to)!.value.map((v) => v.address)).toEqual(["bob@broker.example"]);
    expect(mail.cc).toBeUndefined();
    expect(mail.bcc).toBeUndefined();
    expect(mail.text?.trim()).toBe("Thanks Bob - yes, I can cover that.");
    expect(t.deps.delivered[0]!.envelope).toEqual({ from: "owner@roadtolegacytrucking.com", to: "bob@broker.example" });
  });
  it("a Message-ID WE generated for a message that had none is not used as a thread anchor", () => {
    expect(isThreadable("<generated-0123abcd@local>")).toBe(false);
    expect(isThreadable("<ok@host.example>")).toBe(true);
    expect(isThreadable(null)).toBe(false);
    const out = buildOutgoing({ from: "owner@x.com", to: "a@b.com", subject: "Re: x\r\nBcc: evil@x.com", body: "b", originalMessageId: "<generated-0123abcd@local>", now: NOW });
    expect(out.inReplyTo).toBeNull();
    expect(out.subject).not.toMatch(/[\r\n]/);
  });
});

describe("record, Sent folder and failures", () => {
  it("records the send (hash of the approved text, reply anchor) and appends a copy to the Sent folder", async () => {
    const t = await setup();
    const r = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint(t.draft.body) });
    expect(r.ok && r.storedInSentFolder).toBe(true);
    expect(t.store.sent).toHaveLength(1);
    expect(t.store.sent[0]).toMatchObject({ mailbox: "owner", emailMessageId: t.original, toAddress: "bob@broker.example", subject: "Re: Load question", inReplyTo: "<orig-123@broker.example>", approvedBodyHash: bodyHash(t.draft.body), storedInSentFolder: true });
    expect(t.store.drafts[0]!.status).toBe("sent");
    expect(t.deps.appended).toHaveLength(1);
    expect(t.deps.appended[0]!.equals(t.deps.delivered[0]!.raw)).toBe(true); // the same bytes that were sent
  });
  it("a failed Sent-folder copy does not undo the send; the record stands and says so", async () => {
    const t = await setup();
    t.deps.appendSent = vi.fn(async () => false);
    const r = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint(t.draft.body) });
    expect(r.ok).toBe(true);
    expect(r.ok && r.warning).toMatch(/Sent folder/);
    expect(t.store.sent[0]!.storedInSentFolder).toBe(false);
    expect(t.store.drafts[0]!.status).toBe("sent");
  });
  it("a login failure is reported in plain words and is NOT retried", async () => {
    const t = await setup();
    t.deps.deliver = vi.fn(async () => { throw Object.assign(new Error("Invalid login pw-owner"), { code: "EAUTH", responseCode: 535 }); });
    const r = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint(t.draft.body) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe("auth");
    expect(!r.ok && r.reason).not.toContain("pw-owner");
    expect(t.deps.deliver).toHaveBeenCalledTimes(1);
    expect(t.store.drafts[0]).toMatchObject({ status: "failed" });
    expect(t.store.drafts[0]!.sendError).toMatch(/password may have changed/);
    expect(t.deps.notified[0]).toMatch(/owner@ send failed/);
    expect(t.store.sent).toHaveLength(0);
  });
  it("a rejected recipient is not retried either", async () => {
    const t = await setup();
    t.deps.deliver = vi.fn(async () => { throw Object.assign(new Error("550 no such user"), { responseCode: 550 }); });
    const r = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint(t.draft.body) });
    expect(!r.ok && r.kind).toBe("recipient");
    expect(t.deps.deliver).toHaveBeenCalledTimes(1);
  });
  it("a connection failure gets exactly ONE retry, then it is reported (no loop)", async () => {
    const t = await setup();
    t.deps.deliver = vi.fn(async () => { throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }); });
    const r = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint(t.draft.body) });
    expect(!r.ok && r.kind).toBe("network");
    expect(t.deps.deliver).toHaveBeenCalledTimes(2);
    expect(t.store.drafts[0]!.status).toBe("failed");
  });
  it("a connection failure that clears on the retry still sends once", async () => {
    const t = await setup();
    let n = 0;
    const raws: Buffer[] = [];
    t.deps.deliver = vi.fn(async (_c, _s, _e, raw) => { n += 1; if (n === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); raws.push(raw); });
    const r = await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint(t.draft.body) });
    expect(r.ok).toBe(true);
    expect(raws).toHaveLength(1);
    expect(t.store.sent).toHaveLength(1);
  });
  it("a failed draft can be sent later only through a fresh approval of its (unchanged) text", async () => {
    const t = await setup();
    let fail = true;
    t.deps.deliver = vi.fn(async (_c, _s, e, raw) => { if (fail) throw Object.assign(new Error("x"), { code: "EAUTH" }); t.deps.delivered.push({ envelope: e, raw }); });
    expect((await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint(t.draft.body) })).ok).toBe(false);
    fail = false;
    expect((await sendApprovedDraft(t.deps, { draftId: t.draft.id, approvedFingerprint: bodyFingerprint(t.draft.body) })).ok).toBe(true);
  });
});

describe("config and error wording", () => {
  it("uses IONOS's documented SMTP setting by default and can be switched to 587", () => {
    expect(getSmtpSettings({})).toEqual({ host: "smtp.ionos.com", port: 465, secure: true });
    expect(getSmtpSettings({ IONOS_SMTP_PORT: "587" })).toEqual({ host: "smtp.ionos.com", port: 587, secure: false });
  });
  it("sending reuses the four existing credentials and no new secret", () => {
    expect(getEmailConfig("owner", ENV).ok).toBe(true);
    expect(getEmailConfig("owner", { IONOS_EMAIL_OWNER_USER: "o@x.com" }).ok).toBe(false);
  });
  it("classifies failures", () => {
    expect(classifySmtpError({ code: "EAUTH" }).kind).toBe("auth");
    expect(classifySmtpError({ responseCode: 550 }).kind).toBe("recipient");
    expect(classifySmtpError({ code: "ESOCKET", message: "CERT_HAS_EXPIRED" }).kind).toBe("tls");
    expect(classifySmtpError({ code: "ECONNREFUSED" })).toMatchObject({ kind: "network", retryable: true });
    expect(classifySmtpError(new Error("???")).retryable).toBe(false);
  });
});

describe("the send_email / revise_email_draft tools", () => {
  async function tools(mailbox: "owner" | "dispatch" = "owner") {
    const t = await setup({ mailbox });
    const list = buildEmailTools({ client: {}, companyId: "c" } as never, t.store, t.deps);
    const byName = (n: string) => list.find((x) => x.name === n)!;
    return { ...t, byName };
  }

  it("send_email is ALWAYS a proposal - the model can never execute it directly", async () => {
    const { byName } = await tools();
    expect(byName("send_email").alwaysPropose).toBe(true);
    expect(byName("send_email").access).toBe("write");
  });

  it("the proposal the owner approves is generated from the stored draft: exact recipient, subject and full text", async () => {
    const { byName, draft } = await tools();
    const args = { draft_id: draft.id, fingerprint: bodyFingerprint(draft.body) };
    const verdict = await byName("send_email").verifyProposal!(args);
    expect(verdict.ok).toBe(true);
    const summary = (verdict as { summary: string }).summary;
    expect(summary).toContain("bob@broker.example");
    expect(summary).toContain("Re: Load question");
    expect(summary).toContain("Thanks Bob - yes, I can cover that.");
    expect(summary).toContain("owner@");
  });

  it("is not proposed for a stale fingerprint, a sent draft, an unknown draft, or a dormant dispatch@ draft", async () => {
    const o = await tools();
    expect((await o.byName("send_email").verifyProposal!({ draft_id: o.draft.id, fingerprint: "aaaaaaaaaaaa" })).ok).toBe(false);
    expect((await o.byName("send_email").verifyProposal!({ draft_id: "00000000-0000-4000-8000-000000000999", fingerprint: "aaaaaaaaaaaa" })).ok).toBe(false);
    const d = await tools("dispatch");
    const v = await d.byName("send_email").verifyProposal!({ draft_id: d.draft.id, fingerprint: bodyFingerprint(d.draft.body) });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toMatch(/Dispatch sending isn't switched on/);
    await sendApprovedDraft(o.deps, { draftId: o.draft.id, approvedFingerprint: bodyFingerprint(o.draft.body) });
    expect((await o.byName("send_email").verifyProposal!({ draft_id: o.draft.id, fingerprint: bodyFingerprint(o.draft.body) })).ok).toBe(false);
  });

  it("run() sends the approved draft, and refuses a draft changed after approval", async () => {
    const { byName, draft, deps, store } = await tools();
    const args = { draft_id: draft.id, fingerprint: bodyFingerprint(draft.body) };
    const revised = await byName("revise_email_draft").run({ draft_id: draft.id, body: "A completely different message." });
    expect(revised).toContain("Any earlier approval of the old text is void");
    const refused = await byName("send_email").run(args);
    expect(refused).toMatch(/NOT SENT: The draft was changed after you approved it/);
    expect(deps.delivered).toHaveLength(0);
    const fresh = await byName("send_email").run({ draft_id: draft.id, fingerprint: bodyFingerprint("A completely different message.") });
    expect(fresh).toMatch(/^SENT from owner@ to bob@broker\.example/);
    expect(store.sent).toHaveLength(1);
  });

  it("draft_email_reply shows the whole draft (to, subject, body, fingerprint) and never sends", async () => {
    const t = await setup();
    const list = buildEmailTools({ client: {}, companyId: "c" } as never, t.store, t.deps);
    const out = await list.find((x) => x.name === "draft_email_reply")!.run({ message_id: t.original, body: "Sounds good, Bob." });
    expect(out).toContain("To: bob@broker.example");
    expect(out).toContain("Subject: Re: Load question");
    expect(out).toContain("Sounds good, Bob.");
    expect(out).toMatch(/fingerprint [0-9a-f]{12}/);
    expect(t.deps.delivered).toHaveLength(0);
  });
});

describe("Telegram tells him when owner@ mail arrives", () => {
  const base = { classification: "other" as const, fromName: "Bob", fromAddress: "bob@broker.example", subject: "Load question", summary: "Bob asks if you can cover a load." };
  it("owner@ mail offers a drafted reply; dispatch@ mail does not (sending is dormant there)", () => {
    expect(composeMessageAlert({ ...base, mailbox: "owner" })).toMatch(/I can draft a reply here/);
    expect(composeMessageAlert({ ...base, mailbox: "owner" })).toMatch(/owner@ inbox/);
    expect(composeMessageAlert({ ...base, mailbox: "dispatch" })).not.toMatch(/draft a reply/);
  });
  it("junk never gets a reply offer", () => {
    expect(composeMessageAlert({ ...base, mailbox: "owner", classification: "junk" })).not.toMatch(/draft a reply/);
  });
});
