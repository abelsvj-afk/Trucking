"use client";

// Settings -> Company inbox (docs/design/company-inbox.md section 8): the connection's honest state in plain words.
// OFF (no login on the server), CONNECTED (last good read), or the plain cause of a failure. The mailbox password
// never reaches this screen; it lives only in the server's secrets.

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import type { EmailStatus } from "@/services/email/status";

export default function EmailInboxSettings() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiClient
      .inbox()
      .then((r) => setStatus(r.data.status))
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "Couldn't check the company inbox."));
  }, []);
  return (
    <section aria-label="Company inbox">
      <h2>Company inbox</h2>
      <p>Whether Abel can read the dispatch@ mailbox. He only reads — he can&rsquo;t send, delete or change mail. To cut him off, change that one mailbox&rsquo;s password.</p>
      {!status && !error && <p role="status">Checking…</p>}
      {error && <p role="alert">{error}</p>}
      {status && (
        <p role="status">
          <strong>{status.health === "connected" ? "Connected" : status.health === "off" ? "Off" : status.health === "failing" ? "Not working" : status.health === "stale" ? "Stalled" : "Waiting"}</strong> — {status.message}
        </p>
      )}
      <p><Link href="/more/inbox">Open the company inbox</Link></p>
    </section>
  );
}
