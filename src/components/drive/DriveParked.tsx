// Drive's parked screen (file decomposition of the Drive page, 2026-11-06;
// markup and behavior unchanged - all state stays in the page).

import Link from "next/link";
import DriveClocks from "./DriveClocks";
import DriveStatusPrompt from "./DriveStatusPrompt";
import { driveReviewLines, type DrivePlanSnapshot, type DriveSession } from "@/lib/drive";

export default function DriveParked({
  plan, session, onStart, onEnd,
}: {
  plan: DrivePlanSnapshot;
  session: DriveSession;
  onStart: () => void;
  onEnd: () => void;
}) {
  return (
    <section aria-label="Parked">
      <h2>Parked</h2>
      <DriveClocks />
      <DriveStatusPrompt offer={["off_duty", "on_duty"]} />
      {(
        <>
          <ol>
            {plan.stops.map((stop, i) => (
              <li key={stop.id}>
                <strong>{stop.badge}</strong> {stop.name} — {session.stopStatus[i]}
              </li>
            ))}
          </ol>
          <h3>How the day went</h3>
          {driveReviewLines(plan, session).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button type="button" onClick={onStart} style={{ minHeight: "56px", padding: "0 20px", fontWeight: 700 }}>
              Keep driving
            </button>
            <Link
              href="/smart-path"
              style={{
                minHeight: "56px",
                padding: "0 20px",
                display: "inline-flex",
                alignItems: "center",
                border: "1px solid currentColor",
                borderRadius: "8px",
              }}
            >
              Open the full plan
            </Link>
            <button type="button" onClick={onEnd} style={{ minHeight: "56px", padding: "0 20px" }}>
              End Drive
            </button>
          </div>
        </>
      )}
    </section>
  );
}
