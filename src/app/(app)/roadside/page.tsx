"use client";

// Roadside / DOT inspection mode (docs/design/eld-roadside-overlay.md;
// owner spec 2026-11-09). One tap from Home; built to be handed to an
// officer or read at arm's length: the framing banner first (this is a
// convenience copy - the carrier's ELD / his paper log is the legal
// record), then the packet itself in big type. NO money or pay data
// anywhere on this screen - the packet has none by construction.
//
// The packet text comes from GET /api/v1/roadside/packet, built
// server-side from the one HOS read - the same bytes Abel files, emails
// and drops into Telegram, so the screen can never drift from the record.

import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import RoadsideSendForm from "@/components/roadside/RoadsideSendForm";
import { PACKET_FRAMING } from "@/lib/roadside-packet";

interface PacketData {
  subject: string;
  text: string;
  fileName: string;
  periodStart: string;
  periodEnd: string;
}

type State = { status: "loading" } | { status: "error"; message: string } | { status: "loaded"; packet: PacketData };

export default function RoadsidePage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/roadside/packet")
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as { data?: PacketData; error?: { message?: string } } | null;
        if (cancelled) return;
        if (!res.ok || !json?.data) {
          setState({ status: "error", message: json?.error?.message ?? "Couldn't build the packet just now." });
          return;
        }
        setState({ status: "loaded", packet: json.data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: "Couldn't reach the server. Your paper log is your record at the roadside either way." });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <main className="roadside-page">
      <PageHeader title="Roadside inspection" purpose="Your log packet, ready to show an officer." />
      <p className="roadside-framing" role="note">
        {PACKET_FRAMING}
      </p>
      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={() => setAttempt((n) => n + 1)} />}
      {state.status === "loaded" && (
        <>
          <pre className="roadside-packet" aria-label="Inspection packet">
            {state.packet.text}
          </pre>
          <RoadsideSendForm />
        </>
      )}
    </main>
  );
}
