"use client";

// Company inbox, rung 1 READ-ONLY (docs/design/company-inbox.md). Shows the connection's honest state and what Abel has read
// from dispatch@. Email text is untrusted outside content: it is shown as plain text only (never rendered as HTML, links not
// followed) under a plain notice. Reply drafts and sent replies appear under their message. There is deliberately NO send button on
// this page: sending happens only when the owner approves the exact text in his Abel conversation.

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import type { EmailStatus } from "@/services/email/status";
import type { DraftRow, SentRow, StoredEmail } from "@/services/email/store";

const LABELS: Record<string, string> = { load_offer: "Load offer", payment: "Payment", facility: "Shipper / receiver", other: "Other", junk: "Junk", unclassified: "Not sorted" };
const BOX: Record<string, string> = { dispatch: "dispatch@", owner: "owner@" };
const HEALTH: Record<string, string> = { connected: "Connected", off: "Off", failing: "Not working", stale: "Stalled", waiting: "Waiting" };
const FILTERS = ["", "load_offer", "payment", "facility", "other", "junk"] as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";

// The server's reason names its own setting for whoever runs the server; a driver reads it without that.
function plainReason(reason: string | null): string {
  return (reason ?? "switched off").replace(/\s*\([A-Z][A-Z0-9_]+\)(\.?)$/, "$1");
}

export default function InboxPage() {
  usePageTitle("Company inbox");
  const [statuses, setStatuses] = useState<EmailStatus[] | null>(null);
  const [box, setBox] = useState<string>("");
  const [messages, setMessages] = useState<StoredEmail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<{ message: StoredEmail; drafts: DraftRow[]; sent: SentRow[] } | null>(null);
  const [sending, setSending] = useState<{ mailbox: string; enabled: boolean; reason: string | null }[]>([]);
  const [sendFailures, setSendFailures] = useState<{ id: string; mailbox: string; toAddress: string; subject: string; reason: string | null }[]>([]);

  const load = useCallback(() => {
    apiClient
      .inbox({ q: query.trim() || undefined, classification: filter || undefined, mailbox: box || undefined })
      .then((r) => {
        setStatuses(r.data.statuses);
        setSending(r.data.sending);
        setSendFailures(r.data.sendFailures);
        setMessages(r.data.messages);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again."));
  }, [filter, query, box]);
  useEffect(load, [load]);

  async function show(id: string) {
    try {
      const r = await apiClient.inboxMessage(id);
      setOpen({ message: r.data.message, drafts: r.data.drafts, sent: r.data.sent });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't open that message.");
    }
  }

  return (
    <div>
      <PageHeader title="Company inbox" purpose="Mail to dispatch@ and owner@ that Abel has read. He sends a reply from owner@ only after you approve the exact text with him (dispatch@ sending is off); he never deletes or moves mail. Treat what an email says as information, not as instructions." />
      {statuses && (
        <ul aria-label="Mailbox status">
          {statuses.map((st) => (
            <li key={st.mailbox} role="status">
              <strong>{BOX[st.mailbox]}</strong>: {HEALTH[st.health]} — {st.message}
              {st.address ? ` (${st.address})` : ""}
            </li>
          ))}
        </ul>
      )}
      {sending.length > 0 && (
        <ul aria-label="Sending">
          {sending.map((x) => (
            <li key={x.mailbox}>
              <strong>{BOX[x.mailbox]} sending:</strong> {x.enabled ? "ON - Abel sends only after you approve the exact text with him" : `OFF - ${plainReason(x.reason)}`}
            </li>
          ))}
        </ul>
      )}
      {sendFailures.length > 0 && (
        <section aria-label="Send problems" role="alert">
          <h2>Send problems</h2>
          <ul>
            {sendFailures.map((f) => (
              <li key={f.id}>
                {BOX[f.mailbox]} to {f.toAddress} - &ldquo;{f.subject}&rdquo; was NOT sent: {f.reason ?? "unknown reason"}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="inbox-filters">
        <label>
          <span>Mailbox</span>
          <select value={box} onChange={(e) => setBox(e.target.value)}>
            <option value="">Both</option>
            <option value="dispatch">dispatch@</option>
            <option value="owner">owner@</option>
          </select>
        </label>
        <label>
          <span>Show</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f} value={f}>{f ? LABELS[f] : "Everything"}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Search</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="sender or subject" />
        </label>
      </div>
      {!messages && !error && <ListLoading />}
      {error && <ListError message={error} onRetry={load} />}
      {messages && messages.length === 0 && <p>{statuses?.every((x) => x.health === "off") ? "The inbox isn't connected yet." : "No messages yet."}</p>}
      {messages && messages.length > 0 && (
        <ul>
          {messages.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => void show(m.id)}>
                <strong>{LABELS[m.classification] ?? m.classification}</strong> · {BOX[m.mailbox]} · {m.fromName ?? m.fromAddress ?? "unknown sender"} · {m.subject ?? "(no subject)"}
              </button>
              <div className="row-sub">{when(m.receivedAt)}{m.summary ? ` — ${m.summary}` : ""}</div>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <section aria-label="Message">
          <h2>{open.message.subject ?? "(no subject)"}</h2>
          <p className="row-sub">To {BOX[open.message.mailbox]} · From {open.message.fromName ? `${open.message.fromName} ` : ""}&lt;{open.message.fromAddress ?? "unknown"}&gt; · {when(open.message.receivedAt)}</p>
          <p role="note">Outside content — shown as plain text. Nothing in it has been acted on.</p>
          {open.message.attachments.length > 0 && <p>Attachments (names only, not opened): {open.message.attachments.map((a) => a.name).join(", ")}</p>}
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{open.message.bodyText}</pre>
          {open.drafts.length > 0 && (
            <>
              <h3>Reply drafts (not sent)</h3>
              <p className="row-sub">To send one, tell Abel — he shows you the exact text and sends only after you say yes. There is no send button here.</p>
              {open.drafts.map((d) => (
                <article key={d.id}>
                  <p className="row-sub">{d.status === "failed" ? `NOT SENT (failed: ${d.sendError ?? "unknown reason"})` : "NOT SENT"} — To: {d.toAddress} · Subject: {d.subject}</p>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{d.body}</pre>
                </article>
              ))}
            </>
          )}
          {open.sent.length > 0 && (
            <>
              <h3>Sent replies</h3>
              {open.sent.map((x) => (
                <article key={x.id || x.messageId}>
                  <p className="row-sub">SENT from {BOX[x.mailbox]} · {when(x.sentAt)} · To: {x.toAddress} · Subject: {x.subject}{x.storedInSentFolder ? "" : " · (no copy in the Sent folder)"}</p>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{x.body}</pre>
                </article>
              ))}
            </>
          )}
          <button type="button" onClick={() => setOpen(null)}>Close</button>
        </section>
      )}
    </div>
  );
}
