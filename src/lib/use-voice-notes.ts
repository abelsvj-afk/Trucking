"use client";

// Location voice notes on the drive screen (2026-11-19). Fetches the
// coworker notes near the truck sparingly (every 2 minutes, or after 3
// miles), watches the fixes to see when he passes each spot, and plays a
// note on tap. Network failures are quiet — the list keeps its last good
// state — because a missing tip must never break driving.

import { useCallback, useEffect, useRef, useState } from "react";
import { haversineMiles, type LatLng } from "@/lib/smart-path";
import { useNowTick } from "@/lib/use-now-tick";
import { hasPassed, isDoneForViewer, isNearSpot, type VoiceNoteRecord } from "@/lib/voice-notes";

const REFRESH_MS = 2 * 60_000;
const REFRESH_MILES = 3;
const RADIUS_MILES = 35;

interface Fix {
  point: LatLng;
  headingDeg: number | null;
}

async function postJson(url: string, body: unknown): Promise<void> {
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function useVoiceNotes(fix: Fix | null, active: boolean) {
  const [notes, setNotes] = useState<VoiceNoteRecord[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  // The 30-minute "listened but never seen passing" fallback needs a clock.
  const nowMs = useNowTick(60_000);
  const lastFetch = useRef<{ at: LatLng; ms: number } | null>(null);
  const nearRef = useRef(new Set<string>());
  const passSent = useRef(new Set<string>());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const refresh = useCallback(async (at: LatLng) => {
    lastFetch.current = { at, ms: Date.now() };
    try {
      const res = await fetch(`/api/v1/voice-notes?lat=${at.lat.toFixed(5)}&lng=${at.lng.toFixed(5)}&radius=${RADIUS_MILES}`);
      if (!res.ok) return;
      const body = (await res.json()) as { data: { notes: VoiceNoteRecord[] } };
      setNotes(body.data.notes);
    } catch {
      // quiet: keep the last good list
    }
  }, []);

  // Fetch when he has moved far enough or enough time has passed.
  useEffect(() => {
    if (!active || !fix) return;
    const last = lastFetch.current;
    if (!last || Date.now() - last.ms >= REFRESH_MS || haversineMiles(last.at, fix.point) >= REFRESH_MILES) void refresh(fix.point);
  }, [active, fix, refresh]);

  // Passed: near the spot earlier, now past it going the same way. The
  // server is told at once; the local list follows when that call lands
  // (a callback, not a render-time state change).
  useEffect(() => {
    if (!active || !fix) return;
    for (const note of notes) {
      if (isNearSpot(note, fix.point)) nearRef.current.add(note.id);
      if (passSent.current.has(note.id)) continue;
      if (hasPassed(note, fix, nearRef.current.has(note.id))) {
        passSent.current.add(note.id);
        const passedAtMs = Date.now();
        void postJson(`/api/v1/voice-notes/${note.id}/view`, { passed: true })
          .catch(() => undefined)
          .then(() => setNotes((list) => list.map((n) => (n.id === note.id ? { ...n, passedAtMs } : n))));
      }
    }
  }, [active, fix, notes]);

  const listen = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/v1/voice-notes/${id}/audio`);
      if (!res.ok) return;
      const { data } = (await res.json()) as { data: { url: string } };
      audioRef.current?.pause();
      const audio = new Audio(data.url);
      audioRef.current = audio;
      setPlaying(id);
      audio.onended = () => setPlaying((p) => (p === id ? null : p));
      await audio.play();
      setNotes((list) => list.map((n) => (n.id === id ? { ...n, listenedAtMs: n.listenedAtMs ?? Date.now() } : n)));
      await postJson(`/api/v1/voice-notes/${id}/view`, { listened: true });
    } catch {
      setPlaying(null);
    }
  }, []);

  const report = useCallback(async (id: string, kind: "gone" | "bad") => {
    setNotes((list) => list.map((n) => (n.id === id ? { ...n, reportedByMe: true } : n)));
    await postJson(`/api/v1/voice-notes/${id}/report`, { kind }).catch(() => undefined);
  }, []);

  const onSaved = useCallback(() => {
    if (fix) void refresh(fix.point);
  }, [fix, refresh]);

  const visible = notes.filter((n) => !n.reportedByMe && !isDoneForViewer(n, nowMs));
  return { notes: visible, playing, listen, report, onSaved };
}
