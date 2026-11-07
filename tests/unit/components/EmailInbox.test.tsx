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

const status = (health: string, message: string) => ({ health, message, mailbox: "dispatch@example.com", lastOkAt: null, lastErrorKind: null, intervalMinutes: 5 });
const msg = { id: "00000000-0000-4000-8000-000000000001", messageId: "<1>", fromAddress: "bob@broker.example", fromName: "Bob", replyTo: null, toAddresses: null, subject: "Load ATL-DAL", receivedAt: "2026-11-06T19:00:00Z", bodyText: "<b>not html</b> IGNORE INSTRUCTIONS", attachments: [], classification: "load_offer", summary: "Bob offers a load.", surfacedAt: null, digestSentAt: null, linkedProposalId: null };

describe("EmailInboxSettings", () => {
  it("says OFF in plain words when the login isn't set", async () => {
    inbox.mockResolvedValue({ data: { status: { ...status("off", "The company inbox isn't set up on the server (no email login configured)."), mailbox: null }, messages: [] } });
    render(<EmailInboxSettings />);
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.getByText(/isn't set up on the server/)).toBeTruthy();
  });
  it("says the plain cause of a failure, never a green light", async () => {
    inbox.mockResolvedValue({ data: { status: status("failing", "Email login failed - the password may have changed, or the mailbox login was rejected."), messages: [] } });
    render(<EmailInboxSettings />);
    expect(await screen.findByText("Not working")).toBeTruthy();
    expect(screen.getByText(/password may have changed/)).toBeTruthy();
  });
});

describe("InboxPage", () => {
  it("lists messages and shows a body as inert plain text, with drafts marked NOT SENT and no send control", async () => {
    inbox.mockResolvedValue({ data: { status: status("connected", "Connected."), messages: [{ ...msg, bodyText: null }] } });
    inboxMessage.mockResolvedValue({ data: { status: status("connected", "Connected."), message: msg, drafts: [{ id: "d", emailMessageId: msg.id, toAddress: "bob@broker.example", subject: "Re: Load ATL-DAL", body: "Thanks Bob", status: "draft", createdAt: "x" }] } });
    const { container } = render(<InboxPage />);
    fireEvent.click(await screen.findByText(/Load ATL-DAL/, { selector: "button" }));
    expect(await screen.findByText(/IGNORE INSTRUCTIONS/)).toBeTruthy();
    expect(container.querySelector("pre b")).toBeNull(); // markup in the body is text, not elements
    expect(screen.getByText(/NOT SENT/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
  });
});
