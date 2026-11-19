"use client";

// Leave a voice note at this spot (owner 2026-11-18/19). Built for the cab:
// ONE tap starts recording, one tap stops (it also stops itself at 30 s),
// then big buttons say what kind of note it is, and Save. The note is
// pinned where the truck was when recording STARTED, with the direction of
// travel, so it shows to coworkers coming the same way.
//
// The phone asks for the microphone the first time; a "no" is said plainly.

import { useEffect, useRef, useState } from "react";
import { VOICE_NOTE_KINDS, VOICE_NOTE_LABEL, VOICE_NOTE_MAX_SECONDS, type VoiceNoteKind } from "@/lib/voice-notes";
import type { LatLng } from "@/lib/smart-path";

interface Props {
  /** The truck right now; null = no fix yet (the mic is disabled). */
  fix: { point: LatLng; headingDeg: number | null } | null;
  roadRef: string | null;
  onSaved: () => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "recording"; startedAtMs: number }
  | { kind: "choose"; blob: Blob; durationS: number }
  | { kind: "saving" };

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return "";
}

export default function VoiceNoteRecorder({ fix, roadRef, onSaved }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [message, setMessage] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const pinRef = useRef<{ point: LatLng; headingDeg: number | null } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function start() {
    setMessage(null);
    if (!fix) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage("This phone's browser can't record here.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMessage("The microphone is blocked. Allow it for this site in the phone's settings.");
      return;
    }
    const mimeType = pickMimeType();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    pinRef.current = { point: fix.point, headingDeg: fix.headingDeg };
    const startedAtMs = Date.now();
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const durationS = Math.max(0.5, Math.min(VOICE_NOTE_MAX_SECONDS, (Date.now() - startedAtMs) / 1000));
      const blob = new Blob(chunksRef.current, { type: (rec.mimeType || mimeType || "audio/webm").split(";")[0] });
      setPhase({ kind: "choose", blob, durationS });
    };
    recorderRef.current = rec;
    rec.start();
    setPhase({ kind: "recording", startedAtMs });
    timerRef.current = setTimeout(() => stop(), VOICE_NOTE_MAX_SECONDS * 1000);
  }

  function stop() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  async function save(kind: VoiceNoteKind, blob: Blob, durationS: number) {
    const pin = pinRef.current;
    if (!pin) return;
    setPhase({ kind: "saving" });
    const form = new FormData();
    form.set("audio", blob, "note");
    form.set("kind", kind);
    form.set("lat", String(pin.point.lat));
    form.set("lng", String(pin.point.lng));
    form.set("heading", pin.headingDeg === null ? "" : String(Math.round(pin.headingDeg) % 360));
    if (roadRef) form.set("roadRef", roadRef);
    form.set("durationS", durationS.toFixed(1));
    try {
      const res = await fetch("/api/v1/voice-notes", { method: "POST", body: form });
      if (!res.ok) throw new Error(String(res.status));
      setMessage("Voice note left here for the drivers behind you.");
      onSaved();
    } catch {
      setMessage("Couldn't save the voice note. Try again when you have signal.");
    }
    setPhase({ kind: "idle" });
  }

  const recording = phase.kind === "recording";
  return (
    <div style={{ pointerEvents: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" }}>
      {phase.kind === "choose" ? (
        <div role="dialog" aria-label="What kind of note?" style={{ background: "#111827", color: "#fff", borderRadius: "12px", padding: "10px", display: "grid", gap: "6px", width: "220px" }}>
          <strong>What is it?</strong>
          {VOICE_NOTE_KINDS.map((k) => (
            <button key={k} type="button" onClick={() => void save(k, phase.blob, phase.durationS)} style={{ padding: "10px", fontSize: "1.05rem", fontWeight: 700 }}>
              {VOICE_NOTE_LABEL[k]}
            </button>
          ))}
          <button type="button" onClick={() => setPhase({ kind: "idle" })}>Discard</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => (recording ? stop() : void start())}
          disabled={!fix || phase.kind === "saving"}
          aria-pressed={recording}
          aria-label={recording ? "Stop recording the voice note" : "Leave a voice note here"}
          style={{
            width: "58px",
            height: "58px",
            borderRadius: "16px",
            border: "none",
            background: recording ? "#dc2626" : "#c9a227",
            color: "#111827",
            fontSize: "1.6rem",
            boxShadow: "0 2px 8px rgba(0,0,0,.35)",
          }}
        >
          {recording ? "■" : "🎙"}
        </button>
      )}
      {recording && <span style={{ background: "#dc2626", color: "#fff", borderRadius: "8px", padding: "2px 8px", fontWeight: 700 }}>Recording… tap to stop</span>}
      {message && (
        <span role="status" style={{ background: "rgba(255,255,255,.95)", color: "#111827", borderRadius: "8px", padding: "4px 8px", maxWidth: "220px" }}>
          {message}
        </span>
      )}
    </div>
  );
}
