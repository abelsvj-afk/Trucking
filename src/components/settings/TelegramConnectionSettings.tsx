"use client";

// Settings -> Telegram connection (docs/design/driver-mvp.md section 4; bots & Telegram audit BT-007/BT-008).
// One card per bot account on the team: is its token set (never shown), is the token really that bot,
// is Telegram delivering messages / edits (Live Location) / button taps, what is waiting, the last
// error - and ONE next step for anything wrong: the in-app Fix where re-registering the same address
// solves it, otherwise exactly what King has to set. Tokens and the webhook secret never reach this screen.

import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import type { FaceWebhookReport, WebhookReport } from "@/services/telegram/webhook-admin";

function FaceCard({
  name,
  username,
  report,
  busy,
  onFix,
}: {
  name: string;
  username: string | null;
  report: WebhookReport;
  busy: boolean;
  onFix: () => void;
}) {
  const status = !report.configured ? "Not set up" : report.healthy ? "Working" : "Needs attention";
  return (
    <li className="card" aria-label={`${name} connection`}>
      <p role="status">
        <strong>{name}</strong>
        {username ? ` · @${username}` : ""} — <strong>{status}</strong>
        {report.host ? ` · ${report.host}` : ""}
        {report.pendingCount > 0 ? ` · ${report.pendingCount} waiting` : ""}
      </p>
      {report.configured && (
        <ul>
          {report.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {report.nextStep.kind === "repair" && (
        <p>
          <button type="button" onClick={onFix} disabled={busy}>
            {busy ? "Fixing…" : "Fix the connection"}
          </button>{" "}
          <span className="row-sub">{report.nextStep.text}</span>
        </p>
      )}
      {report.nextStep.kind === "server" && <p className="row-sub">Next step: {report.nextStep.text}</p>}
    </li>
  );
}

export default function TelegramConnectionSettings() {
  const [report, setReport] = useState<WebhookReport | null>(null);
  const [faces, setFaces] = useState<FaceWebhookReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const check = useCallback(() => {
    apiClient
      .telegramWebhook()
      .then((r) => {
        setReport(r.data);
        setFaces(r.faces ?? null);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "Couldn't check Telegram."));
  }, []);
  useEffect(check, [check]);

  async function repair(slug: string) {
    setBusy(slug);
    setError(null);
    setResult(null);
    try {
      const r = await apiClient.repairTelegramWebhook(slug);
      setResult(r.data.message);
      check();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't reach Telegram.");
    } finally {
      setBusy(null);
    }
  }

  // Abel first, then the bots whose accounts exist; the rest are summarised in one line.
  const wired = (faces ?? []).filter((f) => f.slug === "abel" || f.report.configured);
  const notYet = (faces ?? []).filter((f) => f.slug !== "abel" && !f.report.configured).map((f) => f.name);

  return (
    <section aria-label="Telegram connection">
      <h2>Telegram connection</h2>
      <p>
        Whether Telegram is delivering everything each bot needs: your messages, Live Location movement updates, and button
        taps. Abel&apos;s connection carries your 1:1 chat; the others are the bot team in the group.
      </p>
      {!report && !error && <p role="status">Checking…</p>}
      {error && <p role="alert">{error}</p>}
      {faces ? (
        <ul className="stack">
          {wired.map((f) => (
            <FaceCard
              key={f.slug}
              name={f.name}
              username={f.actualUsername ?? f.expectedUsername}
              report={f.report}
              busy={busy === f.slug}
              onFix={() => void repair(f.slug)}
            />
          ))}
        </ul>
      ) : (
        report && (
          <ul className="stack">
            <FaceCard name="Abel" username={null} report={report} busy={busy === "abel"} onFix={() => void repair("abel")} />
          </ul>
        )
      )}
      {notYet.length > 0 && <p className="row-sub">Not set up yet (no Telegram account on the server): {notYet.join(", ")}.</p>}
      {result && <p role="status">{result}</p>}
      <p>
        <button type="button" onClick={check} disabled={busy !== null}>Check again</button>
      </p>
    </section>
  );
}
