"use client";

// Duty-status prompts around a trip (owner request 2026-11-04). It OFFERS
// - never books. Before GO: "Log Driving?" when he isn't already logged as
// driving. When parked / after the run: "Off duty" / "On duty" when that
// isn't already his status. A tap opens the same confirm sheet as Home
// (time defaults to now, never future, after-the-fact flagged), behind the
// quick (no-typing) sheet while moving; the status switch is never gated on motion.

import { useState } from "react";
import Sheet from "@/components/Sheet";
import StatusSheet, { HUD_STATUS_LABELS } from "@/components/hud/StatusSheet";
import { computeHudClocks } from "@/lib/hud-clocks";
import { useHosWindow } from "@/lib/use-hos-window";
import { useNowTick } from "@/lib/use-now-tick";
import { useVehicleMotionDetail } from "@/lib/use-vehicle-motion";
import type { DutyStatus } from "@/types/entities";

export default function DriveStatusPrompt({ offer }: { offer: DutyStatus[] }) {
  const { state, refresh } = useHosWindow();
  const nowMs = useNowTick(30_000);
  const { state: motion, position } = useVehicleMotionDetail();
  const [picked, setPicked] = useState<DutyStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (state.status !== "loaded") return null;
  const clocks = computeHudClocks(state.data, state.hos, nowMs);
  const current: DutyStatus | null = clocks.state === "ready" ? clocks.status : null;
  const choices = offer.filter((s) => s !== current);

  return (
    <section aria-label="Duty status" className="drive-status-prompt">
      <p style={{ margin: "0 0 6px" }}>
        {current ? (
          <>
            Logged as <strong>{HUD_STATUS_LABELS[current]}</strong>.
          </>
        ) : (
          "No duty status logged yet."
        )}
      </p>
      {choices.length > 0 && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {choices.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setNote(null);
                setPicked(s);
              }}
              style={{ minHeight: "56px", padding: "0 16px", fontWeight: 700 }}
            >
              Log {HUD_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      )}
      {note && (
        <p role="status" style={{ margin: "6px 0 0" }}>
          {note}
        </p>
      )}
      {picked && (
        <Sheet title="Change status" onClose={() => setPicked(null)}>
          <StatusSheet
            key={picked}
            status={picked}
            gps={position}
            quick={motion !== "stopped"}
            onCancel={() => setPicked(null)}
            onSaved={(queued) => {
              setPicked(null);
              setNote(queued ? "No signal — saved on this device; it will sync." : "Status saved.");
              if (!queued) refresh();
            }}
          />
        </Sheet>
      )}
    </section>
  );
}
