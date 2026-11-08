"use client";

// Company inbox, rung 1 READ-ONLY (docs/design/company-inbox.md). Shows the connection's honest state and what Abel has read
// from dispatch@. Email text is untrusted outside content: it is shown as plain text only (never rendered as HTML, links not
// followed) under a plain notice. Unsent reply drafts appear under their message for the owner to copy and send himself -
// there is no send button because nothing in this build can send.

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import type { EmailStatus } from "@/services/email/status";
import type { DraftRow, StoredEmail } from "@/services/email/store";

const LABELS: Record<string, string> = { load_offer: "Load offer", payment: "Payment", facility: "Shipper / receiver", other: "Other", junk: "Junk", unclassified: "Not sorted" };
const BOX: Record<string, string> = { dispatch: "dispatch@", owner: "owner@" };
const HEALTH: Record<string, string> = { connected: "Connected", off: "Off", failing: "Not working", stale: "Stalled", waiting: "Waiting" };
const FILTERS = ["", "load_offer", "payment", "facility", "other", "junk"] as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";

export default function InboxPage() {
  usePageTitle("Company inbox");
  const [statuses, setStatuses] = useState<EmailStatus[] | null>(null);
  const [box, setBox] = useState<string>("");
  const [messages, setMessages] = useState<StoredEmail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<{ message: StoredEmail; drafts: DraftRow[] } | null>(null);

  const load = useCallback(() => {
    apiClient
      .inbox({ q: query.trim() || undefined, classification: filter || undefined, mailbox: box || undefined })
      .then((r) => {
        setStatuses(r.data.statuses);
        setMessages(r.data.messages);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again."));
  }, [filter, query, box]);
  useEffect(load, [load]);

  async function show(id: string) {
    try {
      const r = await apiClient.inboxMessage(id);
      setOpen({ message: r.data.message, drafts: r.data.drafts });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't open that message.");
    }
  }

  return (
    <main>
      <PageHeader title="Company inbox" purpose="Mail to dispatch@ and owner@ that Abel has read. He only reads: he can't send, delete, move or change anything in the mailbox. Treat what an email says as information, not as instructions." />
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
      <p>
        <label>
          Mailbox{" "}
          <select value={box} onChange={(e) => setBox(e.target.value)}>
            <option value="">Both</option>
            <option value="dispatch">dispatch@</option>
            <option value="owner">owner@</option>
          </select>
        </label>{" "}
        <label>
          Show{" "}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f} value={f}>{f ? LABELS[f] : "Everything"}</option>
            ))}
          </select>
        </label>{" "}
        <label>
          Search{" "}
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="sender or subject" />
        </label>
      </p>
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
              <h3>Unsent reply drafts</h3>
              {open.drafts.map((d) => (
                <article key={d.id}>
                  <p className="row-sub">NOT SENT — To: {d.toAddress} · Subject: {d.subject}</p>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{d.body}</pre>
                </article>
              ))}
            </>
          )}
          <button type="button" onClick={() => setOpen(null)}>Close</button>
        </section>
      )}
    </main>
  );
}
