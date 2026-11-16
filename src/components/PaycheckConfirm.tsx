"use client";

// "I got paid" for one paycheck (docs/design/confirm-paycheck.md, owner 2026-11-16). The amount is what hit his
// bank, pre-filled with the expected take-home so a normal week is one tap; his statement can ride along. All the
// arithmetic lives in services/api/paycheck-confirmations.ts - this only collects his answer.

import { useState } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { formatMoney } from "@/lib/money-format";
import { formatDateTime } from "@/lib/time";
import type { ConfirmedPayday } from "@/services/api/paycheck-confirmations";

function dollarsToCents(text: string): number | null {
  const n = Number.parseFloat(text.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export default function PaycheckConfirm({ g, onChanged }: { g: ConfirmedPayday; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState((Math.max(0, g.netLowCents) / 100).toFixed(2));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = g.payday ?? g.periodStart;

  if (g.confirmation) {
    return (
      <p role="status" className="paycheck-confirmed">
        ✅ Paid {formatMoney(g.confirmation.receivedCents)} — you confirmed it {formatDateTime(g.confirmation.confirmedAt)}
        {g.shortfallCents > 0 ? ` · short ${formatMoney(g.shortfallCents)} against the expected take-home` : ""}
        {g.confirmation.statementDocumentId ? " · statement attached" : ""}{" "}
        <button
          type="button"
          className="button-danger-quiet"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await apiClient.undoPaycheckConfirmation(g.periodStart);
              onChanged();
            } catch (err) {
              setError(err instanceof ApiClientError ? err.message : "Couldn't undo that.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Undo
        </button>
        {error && <span role="alert"> {error}</span>}
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        I got paid
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = dollarsToCents(amount);
    if (cents === null) {
      setError("Enter the amount that hit your bank, like 1,234.56.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let statementId: string | null = null;
      const loadId = g.loads[0]?.loadId;
      if (file && loadId) {
        const uploaded = await apiClient.uploadDocument<{ data: { id: string } }>({
          file,
          related_entity_type: "load",
          related_entity_id: loadId,
          doc_type: "settlement",
        });
        statementId = uploaded.data.id;
      }
      await apiClient.confirmPaycheck({
        period_start: g.periodStart,
        period_end: g.periodEnd,
        payday: g.payday,
        received_cents: cents,
        statement_document_id: statementId,
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save that. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label={`Confirm the paycheck for ${label}`} className="paycheck-confirm">
      <label className="form-row">
        What hit your bank
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <label className="form-row">
        Your statement (optional)
        <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <p className="row-sub">Expected take-home: {formatMoney(g.netLowCents)}{g.netHighCents !== g.netLowCents ? ` to ${formatMoney(g.netHighCents)}` : ""}.</p>
      <button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Confirm paycheck"}
      </button>{" "}
      <button type="button" className="button-danger-quiet" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
