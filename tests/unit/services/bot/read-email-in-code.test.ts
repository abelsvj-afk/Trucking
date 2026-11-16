// "What's the email say" after an email notice is answered in code, word for word (owner 2026-11-16).
import { describe, expect, it, vi } from "vitest";
import { asksToReadTheEmail, readEmailIfAsked } from "@/services/bot/email-tools";
import type { BotBrainStore } from "@/services/bot/store";
import type { EmailStore, StoredEmail } from "@/services/email/store";

const mail = (id: string, subject: string, body: string): StoredEmail => ({
  id, mailbox: "owner", messageId: `<${id}@example.com>`, fromAddress: "deals@example.com", fromName: "Example Supply",
  replyTo: null, toAddresses: "owner@example.com", subject, receivedAt: "2026-11-16T20:00:00Z", bodyText: body,
  attachments: [], classification: "unclassified", summary: null, surfacedAt: null, digestSentAt: null, linkedProposalId: null,
});

const NOTICE = "📬 New email - owner@ inbox\nFrom: Example Supply <deals@example.com>\nSubject: A Deal for You\n\nI can draft a reply here.";

function inbox(rows: StoredEmail[]) {
  const list = vi.fn(async (o: { query?: string; limit?: number }) =>
    rows.filter((m) => !o.query || (m.subject ?? "").includes(o.query)).slice(0, o.limit ?? 10));
  return { list } as unknown as EmailStore;
}
const store = {} as BotBrainStore;

describe("reading the email in code", () => {
  it("recognizes the ways he asks", () => {
    for (const t of ["What's the email say", "what does the email say?", "read the email", "open that email", "read it to me", "what does it say"]) {
      expect(asksToReadTheEmail(t), t).toBe(true);
    }
    for (const t of ["How are you", "draft a reply to that email saying we're booked this week and thanks", "check my pay"]) {
      expect(asksToReadTheEmail(t), t).toBe(false);
    }
  });

  it("reads the message the notice named, word for word", async () => {
    const box = inbox([mail("1", "Older thing", "old"), mail("2", "A Deal for You", "Ten percent off paper this week.")]);
    const out = await readEmailIfAsked(store, "What's the email say", NOTICE, box);
    expect(out).toContain("Ten percent off paper this week.");
    expect(out).toContain("A Deal for You");
  });

  it("'read it' with no email notice just before is NOT taken over (the model handles it)", async () => {
    const box = inbox([mail("2", "A Deal for You", "x")]);
    expect(await readEmailIfAsked(store, "read it to me", "Your 14-hour window ends at 7 PM ET.", box)).toBeNull();
  });

  it("an empty inbox says so instead of guessing", async () => {
    expect(await readEmailIfAsked(store, "what does the email say", NOTICE, inbox([]))).toContain("nothing in the inbox");
  });
});
