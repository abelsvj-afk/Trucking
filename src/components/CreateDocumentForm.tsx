"use client";

// Create a document in the app (document creation spec 2026-11-09):
// the Documents page's "Create a document" form - the web twin of
// Abel's create_document tool. For the selected expense it makes the
// record page or the pay-deduction notice from the expense itself;
// for any selected record it makes an invoice or statement from the
// fields typed here. The server builds the document only from
// recorded data / these fields and files it on the record.

import { useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";

const SITUATIONS = [
  { value: "carrier", label: "Working for a carrier" },
  { value: "own_authority", label: "Own authority" },
  { value: "business_records", label: "Business records" },
] as const;

type Situation = (typeof SITUATIONS)[number]["value"];
type Kind = "expense_record" | "deduction_notice" | "invoice" | "statement";

export default function CreateDocumentForm({
  entityType,
  entityId,
  onCreated,
}: {
  entityType: string;
  entityId: string;
  onCreated: () => void;
}) {
  const isExpense = entityType === "expense";
  const [kind, setKind] = useState<Kind>(isExpense ? "expense_record" : "invoice");
  const [situation, setSituation] = useState<Situation>("business_records");
  const [title, setTitle] = useState("");
  const [partyFrom, setPartyFrom] = useState("");
  const [partyTo, setPartyTo] = useState("");
  const [linesText, setLinesText] = useState("");
  const [totalDollars, setTotalDollars] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { kind, situation };
      if (kind === "expense_record" || kind === "deduction_notice") {
        body.expense_id = entityId;
      } else {
        const lines = linesText
          .split("\n")
          .map((raw) => raw.trim())
          .filter(Boolean)
          .map((raw) => {
            const match = /^(.*?)\s*[—:-]\s*\$?([\d,]+(?:\.\d{1,2})?)$/.exec(raw);
            return match
              ? { label: match[1]!.trim(), amount_cents: Math.round(parseFloat(match[2]!.replace(/,/g, "")) * 100) }
              : { label: raw, amount_cents: null };
          });
        body.related_entity_type = entityType;
        body.related_entity_id = entityId;
        body.title = title;
        body.party_from = partyFrom;
        body.party_to = partyTo;
        body.lines = lines;
        body.total_cents = totalDollars.trim() ? Math.round(parseFloat(totalDollars.replace(/[$,]/g, "")) * 100) : null;
        body.notes = notes.trim() ? notes.trim() : null;
      }
      const row = await apiClient.generateDocument<{ file_name: string }>(body);
      setDone(`Created ${row.file_name} — it's filed on this record below.`);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't create that document. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleCreate} aria-label="Create a document">
      <h3>Create a document</h3>
      <p className="row-sub">
        Makes a real document in the app and files it on this record — no photo needed. Abel can do the same from
        Telegram.
      </p>
      <label htmlFor="create-kind">Document</label>
      <select id="create-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
        {isExpense && <option value="expense_record">Expense record (proof page for this expense)</option>}
        {isExpense && <option value="deduction_notice">Pay deduction notice (this expense, out of the check)</option>}
        <option value="invoice">Invoice</option>
        <option value="statement">Statement</option>
      </select>
      <label htmlFor="create-situation">Which books does it belong to?</label>
      <select id="create-situation" value={situation} onChange={(e) => setSituation(e.target.value as Situation)}>
        {SITUATIONS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      {(kind === "invoice" || kind === "statement") && (
        <>
          <label htmlFor="create-title">Title</label>
          <input id="create-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          <label htmlFor="create-from">From</label>
          <input id="create-from" value={partyFrom} onChange={(e) => setPartyFrom(e.target.value)} required />
          <label htmlFor="create-to">To</label>
          <input id="create-to" value={partyTo} onChange={(e) => setPartyTo(e.target.value)} required />
          <label htmlFor="create-lines">Lines — one per line, like “Detention — $75.00” (leave the amount off and it reads “not stated”)</label>
          <textarea id="create-lines" value={linesText} onChange={(e) => setLinesText(e.target.value)} rows={4} required />
          <label htmlFor="create-total">Total ($) — optional</label>
          <input id="create-total" value={totalDollars} onChange={(e) => setTotalDollars(e.target.value)} inputMode="decimal" />
          <label htmlFor="create-notes">Notes — optional</label>
          <input id="create-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {done && <p role="status">{done}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create document"}
      </button>
    </form>
  );
}
