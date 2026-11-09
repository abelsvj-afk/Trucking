"use client";

// The driver-side half of /roadside (docs/design/eld-roadside-overlay.md):
// type the officer's email, confirm, send. The packet above this form is
// the exact text that will be sent (the page and the send endpoint build
// it from the same server-side packet service), so what he sees IS the
// approval - one Send tap, no second hidden step. Plain-words results:
// a failure says what happened and that nothing was sent.

import { useState } from "react";

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; to: string; warning?: string }
  | { kind: "error"; message: string };

export default function RoadsideSendForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<SendState>({ kind: "idle" });

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (state.kind === "sending") return;
    setState({ kind: "sending" });
    try {
      const res = await fetch("/api/v1/roadside/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: email.trim() }),
      });
      const json = (await res.json().catch(() => null)) as
        | { data?: { to: string; warning?: string }; error?: { message?: string } }
        | null;
      if (!res.ok || !json?.data) {
        setState({ kind: "error", message: json?.error?.message ?? "The packet couldn't be sent. Nothing was sent." });
        return;
      }
      setState({ kind: "sent", to: json.data.to, ...(json.data.warning ? { warning: json.data.warning } : {}) });
    } catch {
      setState({ kind: "error", message: "Couldn't reach the server. Nothing was sent - check your connection and try again." });
    }
  }

  if (state.kind === "sent") {
    return (
      <div className="roadside-send" role="status">
        <h2>Packet sent</h2>
        <p>
          The inspection packet was emailed to <strong>{state.to}</strong> from your owner mailbox, with the
          packet file attached. A copy is recorded in the app.
        </p>
        {state.warning && <p role="alert">{state.warning}</p>}
      </div>
    );
  }

  return (
    <form className="roadside-send" onSubmit={onSend}>
      <h2>Email it to the officer</h2>
      <p>
        The packet above is exactly what will be sent - as the email text and as an attached file - from your
        owner mailbox. Check the address with the officer, then send.
      </p>
      <label htmlFor="officer-email">Officer&apos;s email</label>
      <input
        id="officer-email"
        type="email"
        inputMode="email"
        autoComplete="off"
        placeholder="officer@example.gov"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <button type="submit" disabled={state.kind === "sending" || email.trim().length === 0}>
        {state.kind === "sending" ? "Sending…" : "Send the packet"}
      </button>
      {state.kind === "error" && <p role="alert">{state.message}</p>}
    </form>
  );
}
