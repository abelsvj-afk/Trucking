"use client";

// Settings -> Company inbox (docs/design/company-inbox.md section 8): the connection's honest state in plain words.
// OFF (no login on the server), CONNECTED (last good read), or the plain cause of a failure. The mailbox password
// never reaches this screen; it lives only in the server's secrets.

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import type { EmailStatus } from "@/services/email/status";

const HEALTH: Record<string, string> = { connected: "Connected", off: "Off", failing: "Not working", stale: "Stalled", waiting: "Waiting" };

export default function EmailInboxSettings() {
  const [statuses, setStatuses] = useState<EmailStatus[] | null>(null);
  const [sending, setSending] = useState<{ mailbox: string; enabled: boolean; reason: string | null }[]>([]);
  const [failures, setFailures] = useState<{ id: string; mailbox: string; toAddress: string; reason: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiClient
      .inbox()
      .then((r) => {
        setStatuses(r.data.statuses);
        setSending(r.data.sending ?? []);
        setFailures(r.data.sendFailures ?? []);
      })
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "Couldn't check the company inbox."));
  }, []);
  return (
    <section aria-label="Company inbox">
      <h2>Company inbox</h2>
      <p>Whether Abel can read the dispatch@ and owner@ mailboxes, each on its own. He can send a reply from owner@ only after you approve the exact text with him; dispatch@ sending is switched off. He never deletes or moves mail. To cut him off from a mailbox, change that one mailbox&rsquo;s password.</p>
      {!statuses && !error && <p role="status">Checking…</p>}
      {error && <p role="alert">{error}</p>}
      {statuses && (
        <ul>
          {statuses.map((st) => (
            <li key={st.mailbox} role="status">
              <strong>{st.mailbox === "owner" ? "owner@" : "dispatch@"}: {HEALTH[st.health]}</strong> — {st.message}
            </li>
          ))}
        </ul>
      )}
      {sending.length > 0 && (
        <ul aria-label="Sending">
          {sending.map((x) => (
            <li key={x.mailbox}>
              <strong>{x.mailbox === "owner" ? "owner@" : "dispatch@"} sending:</strong>{" "}
              {x.enabled ? "ON — Abel sends only after you approve the exact text with him" : `OFF — ${x.reason ?? "switched off"}`}
            </li>
          ))}
        </ul>
      )}
      {failures.length > 0 && (
        <p role="alert">
          {failures.length} reply{failures.length === 1 ? "" : " replies"} did NOT send: {failures[0]!.reason ?? "unknown reason"}
        </p>
      )}
      <p><Link href="/more/inbox">Open the company inbox</Link></p>
    </section>
  );
}
