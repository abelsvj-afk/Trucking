// Drive's pre-roll "preview" screen (file decomposition of the Drive page,
// 2026-11-06; markup and behavior unchanged - all state stays in the page).

import DriveClocks from "./DriveClocks";
import DriveStatusPrompt from "./DriveStatusPrompt";
import { DRIVE_COPY, DRIVE_SETTINGS, type DrivePlanSnapshot, type DriveSession } from "@/lib/drive";
import { formatMinutes } from "@/lib/smart-path";

export default function DrivePreview({
  plan, session, resumeAvailable, permissionDenied, layout, onGo, onDiscard, onLayout,
}: {
  plan: DrivePlanSnapshot;
  session: DriveSession | null;
  resumeAvailable: boolean;
  permissionDenied: boolean;
  layout: "map" | "coach";
  onGo: () => void;
  onDiscard: () => void;
  onLayout: (next: "map" | "coach") => void;
}) {
  return (
    <section aria-label="Drive preview">
      {resumeAvailable && session && (
        <div
          style={{
            border: "2px solid #2563eb",
            borderRadius: "12px",
            padding: "12px",
            marginBottom: "12px",
          }}
        >
          <p style={{ fontSize: "1.25rem", fontWeight: 700 }}>
            You were mid-run to {plan.destinationLabel}. Resume Drive?
          </p>
          <button
            type="button"
            onClick={onGo}
            style={{ minHeight: "56px", padding: "0 24px", fontSize: "1.1rem", fontWeight: 700 }}
          >
            Resume Drive
          </button>{" "}
          <button type="button" onClick={onDiscard} style={{ minHeight: "56px", padding: "0 16px" }}>
            Discard
          </button>
        </div>
      )}
      {permissionDenied && <p role="alert">{DRIVE_COPY.permissionDenied}</p>}
      <p>
        {Math.round(plan.totalMiles)} miles · planned arrival{" "}
        {plan.arrivalAt
          ? new Date(plan.arrivalAt).toLocaleString("en-US", { timeZone: "America/New_York" })
          : "—"}
      </p>
      <p>{DRIVE_COPY.coverageCaveat}</p>
      <p>
        Screen off? In Telegram, tap the paperclip → Location → Share My Live Location with Abel
        for 8 hours. Drive then keeps your place from it, and Abel will ask before changing your
        log — he never books anything on his own.
      </p>
      <p>{DRIVE_COPY.hoursSmallPrint}</p>
      <p>
        {plan.maneuvers.length > 0
          ? "Turn prompts are on for this run."
          : "This plan has no turn prompts — Drive will guide by next stop only."}
      </p>

      <h2>The day</h2>
      <ul>
        {plan.timeline.map((segment) => (
          <li key={`${segment.kind}-${segment.label}`}>
            {segment.label}: {formatMinutes(segment.minutes)}
          </li>
        ))}
      </ul>

      <h2>Stops</h2>
      <ol>
        {plan.stops.map((stop, i) => (
          <li key={stop.id}>
            <strong>{stop.badge}</strong> {stop.name}
            {session && session.stopStatus[i] !== "pending"
              ? ` — ${session.stopStatus[i]}`
              : ""}
          </li>
        ))}
      </ol>

      {DRIVE_SETTINGS.coachLayoutAvailable && (
        <fieldset>
          <legend>Layout</legend>
          <label>
            <input
              type="radio"
              name="drive-layout"
              checked={layout === "map"}
              onChange={() => onLayout("map")}
            />{" "}
            Map leads
          </label>{" "}
          <label>
            <input
              type="radio"
              name="drive-layout"
              checked={layout === "coach"}
              onChange={() => onLayout("coach")}
            />{" "}
            Coach — compact card, for running beside your ELD nav
          </label>
        </fieldset>
      )}

      {!resumeAvailable && (
        <button
          type="button"
          onClick={onGo}
          style={{
            minHeight: "72px",
            padding: "0 32px",
            fontSize: "1.5rem",
            fontWeight: 800,
            borderRadius: "12px",
          }}
        >
          GO
        </button>
      )}
      <DriveClocks />
      <DriveStatusPrompt offer={["driving"]} />
    </section>
  );
}
