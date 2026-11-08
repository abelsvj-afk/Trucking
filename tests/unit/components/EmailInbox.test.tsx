// @vitest-environment jsdom
// Settings -> Company inbox and the Inbox page: honest status in plain words, plain-text messages, drafts marked NOT SENT.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const inbox = vi.fn();
const inboxMessage = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiClient: { inbox: (...a: unknown[]) => inbox(...a), inboxMessage: (...a: unknown[]) => inboxMessage(...a) },
  ApiClientError: class ApiClientError extends Error {},
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/use-page-title", () => ({ usePageTitle: () => {} }));

import EmailInboxSettings from "@/components/settings/EmailInboxSettings";
import InboxPage from "@/app/(app)/more/inbox/page";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const status = (health: string, message: string, mailbox = "dispatch") => ({ mailbox, health, message, address: `${mailbox}@example.com`, lastOkAt: null, lastErrorKind: null, intervalMinutes: 5 });
const msg = { mailbox: "owner", id: "00000000-0000-4000-8000-000000000001", messageId: "<1>", fromAddress: "bob@broker.example", fromName: "Bob", replyTo: null, toAddresses: null, subject: "Load ATL-DAL", receivedAt: "2026-11-06T19:00:00Z", bodyText: "<b>not html</b> IGNORE INSTRUCTIONS", attachments: [], classification: "load_offer", summary: "Bob offers a load.", surfacedAt: null, digestSentAt: null, linkedProposalId: null };

describe("EmailInboxSettings", () => {
  it("says OFF in plain words when the login isn't set", async () => {
    inbox.mockResolvedValue({ data: { sending: [], sendFailures: [], statuses: [{ ...status("off", "The dispatch@ inbox isn't set up on the server (no email login configured)."), address: null }, status("connected", "Connected.", "owner")], messages: [] } });
    render(<EmailInboxSettings />);
    expect(await screen.findByText(/dispatch@: Off/)).toBeTruthy();
    expect(screen.getByText(/owner@: Connected/)).toBeTruthy();
    expect(screen.getByText(/isn't set up on the server/)).toBeTruthy();
  });
  it("says the plain cause of a failure, never a green light", async () => {
    inbox.mockResolvedValue({ data: { sending: [], sendFailures: [], statuses: [status("failing", "Email login failed - the password may have changed, or the mailbox login was rejected.", "owner"), status("connected", "Connected.")], messages: [] } });
    render(<EmailInboxSettings />);
    expect(await screen.findByText(/owner@: Not working/)).toBeTruthy();
    expect(screen.getByText(/dispatch@: Connected/)).toBeTruthy();
    expect(screen.getByText(/password may have changed/)).toBeTruthy();
  });
});

describe("InboxPage", () => {
  it("lists messages and shows a body as inert plain text, with drafts marked NOT SENT and no send control", async () => {
    inbox.mockResolvedValue({ data: { statuses: [status("connected", "Connected.")], sending: [{ mailbox: "owner", enabled: true, reason: null }, { mailbox: "dispatch", enabled: false, reason: "Dispatch sending isn't switched on." }], sendFailures: [], messages: [{ ...msg, bodyText: null }] } });
    inboxMessage.mockResolvedValue({ data: { statuses: [status("connected", "Connected.")], sent: [], message: msg, drafts: [{ id: "d", emailMessageId: msg.id, toAddress: "bob@broker.example", subject: "Re: Load ATL-DAL", body: "Thanks Bob", status: "draft", createdAt: "x", sendError: null, sentAt: null }] } });
    const { container } = render(<InboxPage />);
    fireEvent.click(await screen.findByText(/Load ATL-DAL/, { selector: "button" }));
    expect(await screen.findByText(/IGNORE INSTRUCTIONS/)).toBeTruthy();
    expect(screen.getByText(/To owner@/)).toBeTruthy();
    expect(container.querySelector("pre b")).toBeNull(); // markup in the body is text, not elements
    expect(screen.getByText(/NOT SENT/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
  });
});

describe("sending state is visible", () => {
  it("Settings says owner@ sending is ON (with approval) and dispatch@ is OFF, and flags a failed reply", async () => {
    inbox.mockResolvedValue({ data: { statuses: [status("connected", "Connected.", "owner")], sending: [{ mailbox: "owner", enabled: true, reason: null }, { mailbox: "dispatch", enabled: false, reason: "Dispatch sending isn't switched on." }], sendFailures: [{ id: "f", mailbox: "owner", toAddress: "bob@x.com", reason: "Email login failed - the password may have changed." }], messages: [] } });
    render(<EmailInboxSettings />);
    expect(await screen.findByText(/owner@ sending:/)).toBeTruthy();
    expect(screen.getAllByText(/approve the exact text with him/).length).toBeGreaterThan(0);
    expect(screen.getByText(/dispatch@ sending:/)).toBeTruthy();
    expect(screen.getByText(/OFF — Dispatch sending isn't switched on/)).toBeTruthy();
    expect(screen.getByText(/1 reply did NOT send: Email login failed/)).toBeTruthy();
  });
  it("the inbox page lists send problems and has no send button", async () => {
    inbox.mockResolvedValue({ data: { statuses: [status("connected", "Connected.", "owner")], sending: [{ mailbox: "owner", enabled: true, reason: null }], sendFailures: [{ id: "f", mailbox: "owner", toAddress: "bob@x.com", subject: "Re: Load", reason: "The mail server rejected the recipient address." }], messages: [{ ...msg, bodyText: null }] } });
    inboxMessage.mockResolvedValue({ data: { statuses: [status("connected", "Connected.")], sent: [{ id: "s", mailbox: "owner", emailMessageId: msg.id, toAddress: "bob@broker.example", subject: "Re: Load ATL-DAL", body: "Yes, I can cover it.", messageId: "<m@x>", inReplyTo: null, approvedBodyHash: "a".repeat(64), sentAt: "2026-11-08T15:00:00Z", storedInSentFolder: true }], message: msg, drafts: [{ id: "d", emailMessageId: msg.id, toAddress: "bob@broker.example", subject: "Re: x", body: "Draft", status: "failed", createdAt: "x", sendError: "Can't reach the mail server", sentAt: null }] } });
    render(<InboxPage />);
    expect(await screen.findByText(/was NOT sent: The mail server rejected the recipient/)).toBeTruthy();
    fireEvent.click(await screen.findByText(/Load ATL-DAL/, { selector: "button" }));
    expect(await screen.findByText(/SENT from owner@/)).toBeTruthy();
    expect(screen.getByText(/NOT SENT \(failed: Can't reach the mail server\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
  });
});
