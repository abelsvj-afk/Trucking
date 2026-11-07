"use client";

// Settings -> Telegram connection (docs/design/driver-mvp.md section 4). Says in plain words whether Telegram is
// delivering everything Abel needs - messages, message edits (Live Location movement) and button taps - and offers
// ONE repair: re-register the existing webhook with all three. The bot token and webhook secret never reach this
// screen; the server uses its own copies.

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import type { WebhookReport } from "@/services/telegram/webhook-admin";

export default function TelegramConnectionSettings() {
  const [report, setReport] = useState<WebhookReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const check = useCallback(() => {
    apiClient
      .telegramWebhook()
      .then((r) => {
        setReport(r.data);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "Couldn't check Telegram."));
  }, []);
  useEffect(check, [check]);

  async function repair() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await apiClient.repairTelegramWebhook();
      setReport(r.data.after);
      setResult(r.data.message);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't reach Telegram.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Telegram connection">
      <h2>Telegram connection</h2>
      <p>Whether Telegram is delivering everything Abel needs: your messages, Live Location movement updates, and button taps.</p>
      {!report && !error && <p role="status">Checking…</p>}
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p role="status">
            <strong>{report.healthy ? "Working" : "Needs attention"}</strong>
            {report.host ? ` · ${report.host}` : ""}
            {report.pendingCount > 0 ? ` · ${report.pendingCount} waiting` : ""}
          </p>
          <ul>
            {report.findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          {report.registered && report.missing.length > 0 && (
            <p>
              <button type="button" onClick={() => void repair()} disabled={busy}>
                {busy ? "Fixing…" : "Fix the connection"}
              </button>{" "}
              <span className="row-sub">Re-registers the same address with messages, edits and button taps. Nothing else changes.</span>
            </p>
          )}
        </>
      )}
      {result && <p role="status">{result}</p>}
      <p>
        <button type="button" onClick={check} disabled={busy}>Check again</button>
      </p>
    </section>
  );
}
