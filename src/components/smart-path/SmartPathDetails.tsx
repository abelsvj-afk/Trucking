"use client";

// Smart Path v2 (docs/design/smart-path-v2.md): every detail the v1 page printed - deadhead, along-the-route
// times, weather, road work, state rules, the legal / rested / life / paid lines, fuel ranking, food, and the
// engine's notes - moved here unchanged and shown folded under "Details". Nothing was dropped; it just no longer
// buries the answer.

import { formatEastern, formatMinutes } from "@/lib/smart-path";
import { formatFuelPriceLine } from "@/lib/smart-path-stops";
import { formatMoney } from "@/lib/money-format";
import type { RouteCheckResponse } from "@/types/smart-path";

export default function SmartPathDetails({ result }: { result: RouteCheckResponse }) {
  const workoutOutcome = result.plan?.workout ?? null;
  // The workout block renders plan.workout's own line, so a lifeLine that already says it is not repeated.
  const lifeLinesToRender = workoutOutcome
    ? result.verdict.lifeLines.filter((line) => !line.startsWith("Workout:"))
    : result.verdict.lifeLines;
  return (
    <div className="smart-path-details">
      {result.deadhead && (
        <>
          <h3>Deadhead — getting to the pickup</h3>
          <p>
            {result.deadhead.distanceMiles} mi · about{" "}
            {formatMinutes(result.deadhead.providerDurationMinutes)} driving by the routing
            estimate · leave {result.deadhead.startLabel} by{" "}
            {formatEastern(new Date(result.deadhead.leaveByAt))} · you&apos;d reach the pickup{" "}
            {formatEastern(new Date(result.deadhead.pickupArrivalAt))}
          </p>
          {result.deadhead.waitMinutesAtPickup > 0 && (
            <p>
              That leaves {formatMinutes(result.deadhead.waitMinutesAtPickup)} waiting at the
              pickup — it counts on your 14.
            </p>
          )}
        </>
      )}

      {result.corridor && "points" in result.corridor && result.corridor.points.length > 1 && (
        <details>
          <summary>Along the route — states and when you reach each stretch</summary>
          <p>
            {result.corridor.states
              .map((st) => `${st.state ?? "outside the map"} (mile ${st.enterMile}–${st.exitMile})`)
              .join(" → ")}
            . State borders are approximate (a few miles).
          </p>
          <ul>
            {result.corridor.points
              .filter((pt, i, all) => i === 0 || i === all.length - 1 || pt.mile % 50 === 0)
              .map((pt) => (
                <li key={pt.mile}>
                  Mile {Math.round(pt.mile)}: {pt.etaAt ? formatEastern(new Date(pt.etaAt)) : "time unavailable"}
                </li>
              ))}
          </ul>
          <p className="row-sub">From the plan above (drive time, breaks and rests). Weather, fuel by region, state rules and road work will read this same line.</p>
        </details>
      )}
      {result.corridor && "unavailableReason" in result.corridor && (
        <p role="note">Along-the-route times unavailable: {result.corridor.unavailableReason}</p>
      )}

      {result.weather && (
        <details open={result.weather.items.some((i) => i.severe)}>
          <summary>
            Weather on the route{result.weather.items.length > 0 ? ` — ${result.weather.items.length} to know` : ""}
            {result.weather.status !== "ok" && ` (${result.weather.status})`}
          </summary>
          {result.weather.items.length === 0 && result.weather.status !== "unavailable" && (
            <p>Nothing in the National Weather Service forecast at the spots checked, for the times you&apos;d be there.</p>
          )}
          <ul>
            {result.weather.items.map((w) => (
              <li key={`${w.kind}-${w.mile}-${w.text}`}>
                {w.severe ? "⚠ " : ""}Mile {Math.round(w.mile)}
                {w.endMile > w.mile ? `–${Math.round(w.endMile)}` : ""} (about {formatEastern(new Date(w.etaAt))}): {w.text}
              </li>
            ))}
          </ul>
          {result.weather.notes.map((n) => (
            <p key={n} className="row-sub">{n}</p>
          ))}
          <p className="row-sub">Forecast as of {formatEastern(new Date(result.weather.asOf))}. Advisory — it doesn&apos;t change the verdict; check conditions before you roll.</p>
        </details>
      )}

      {result.roadWork && (
        <details open={result.roadWork.items.some((i) => i.exceedsTruck)}>
          <summary>
            Road work{result.roadWork.items.length > 0 ? ` — ${result.roadWork.items.length} near the route` : ""}
            {result.roadWork.status !== "ok" && ` (${result.roadWork.status})`}
          </summary>
          <ul>
            {result.roadWork.items.map((w, i) => (
              <li key={`${w.mile}-${i}`}>
                {w.exceedsTruck ? "⚠ " : ""}Mile {Math.round(w.mile)} (about {formatEastern(new Date(w.etaAt))}): {w.text}
              </li>
            ))}
          </ul>
          {result.roadWork.notes.map((n) => (
            <p key={n} className="row-sub">{n}</p>
          ))}
          <p className="row-sub">From state work-zone feeds, as of {formatEastern(new Date(result.roadWork.asOf))}. Advisory — it never says a road is open or closed.</p>
        </details>
      )}

      {result.traffic && (
        <details open={result.traffic.items.some((i) => i.severity === "severe") || result.traffic.call.decision === "reroute"}>
          <summary>
            Traffic ahead{result.traffic.items.length > 0 ? ` — ${result.traffic.items.length} reported ${result.traffic.items.length === 1 ? "delay" : "delays"}` : " — no reported delays"}
            {result.traffic.status !== "ok" && ` (${result.traffic.status})`}
          </summary>
          <p><strong>{result.traffic.call.reason}</strong></p>
          {result.traffic.items.length === 0 && result.traffic.status !== "unavailable" && (
            <p>No reported delays on this route right now.</p>
          )}
          <ul>
            {result.traffic.items.map((t) => (
              <li key={t.id}>
                {t.severity === "severe" ? "🔴 " : t.severity === "moderate" ? "🟠 " : ""}Mile {Math.round(t.mile)}
                {t.endMile > t.mile ? `–${Math.round(t.endMile)}` : ""}
                {t.etaAt ? ` (about ${formatEastern(new Date(t.etaAt))})` : ""}: {t.text}
              </li>
            ))}
          </ul>
          {result.traffic.notes.map((n) => (
            <p key={n} className="row-sub">{n}</p>
          ))}
          <p className="row-sub">From TomTom&apos;s live incidents, as of {formatEastern(new Date(result.traffic.asOf))}. Advisory — a stretch with no color means no reported incident, not a clear road, and it never changes the verdict.</p>
        </details>
      )}

      {result.bridges && (
        <details open={result.bridges.items.some((i) => i.clearance === "below" || i.clearance === "tight")}>
          <summary>
            Bridges ahead{result.bridges.items.length > 0 ? ` — ${result.bridges.items.length} with a posted clearance` : ""}
            {result.bridges.status !== "ok" && ` (${result.bridges.status})`}
          </summary>
          {result.bridges.items.length === 0 && result.bridges.status !== "unavailable" && (
            <p>No bridges with a posted clearance found on this route.</p>
          )}
          <ul>
            {result.bridges.items.map((b) => (
              <li key={b.id}>
                {b.clearance === "below" ? "⚠ " : b.clearance === "tight" ? "⚠ " : ""}Mile {Math.round(b.mile)}
                {b.etaAt ? ` (about ${formatEastern(new Date(b.etaAt))})` : ""}: {b.text}
              </li>
            ))}
          </ul>
          {result.bridges.notes.map((n) => (
            <p key={n} className="row-sub">{n}</p>
          ))}
          <p className="row-sub">From the map&apos;s posted clearances, as of {formatEastern(new Date(result.bridges.asOf))}. Advisory — a bridge with no posted clearance isn&apos;t listed and isn&apos;t a pass; check the signs and your truck&apos;s own nav.</p>
        </details>
      )}
      {result.stateRules && result.stateRules.length > 0 && (
        <details open={result.stateRules.some((r) => r.kind === "exceeds")}>
          <summary>State truck rules on this route</summary>
          <ul>
            {result.stateRules.map((r, i) => (
              <li key={`${r.state}-${i}`}>
                {r.kind === "exceeds" ? "⚠ " : ""}{r.text}
                {r.sourceUrl && (
                  <>
                    {" "}
                    <a href={r.sourceUrl} rel="noopener noreferrer" target="_blank">source</a>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="row-sub">Only rules someone verified against the state&apos;s own source are listed. A state with none on file is not &quot;unrestricted&quot; — check the posted signs and your carrier.</p>
        </details>
      )}

      <h3>Legal</h3>
      {result.verdict.legalLines.map((line) => (
        <p key={line}>{line}</p>
      ))}

      <h3>Rested — the sleep plan</h3>
      {result.verdict.restedLines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {result.plan && result.plan.breaks.length > 0 && (
        <p>
          {result.plan.breaks
            .map(
              (b) =>
                `${b.kind === "workout" ? "Workout break" : "Break"} (${formatMinutes(b.durationMinutes)}): ${formatEastern(new Date(b.startAt))}`,
            )
            .join(" · ")}
          .
        </p>
      )}

      {(lifeLinesToRender.length > 0 || workoutOutcome) && (
        <>
          <h3>Your life on this run</h3>
          {lifeLinesToRender.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {workoutOutcome &&
            (workoutOutcome.placed ? (
              <p>
                Workout: {workoutOutcome.durationMinutes} min at {workoutOutcome.placeName} —{" "}
                {workoutOutcome.note}
              </p>
            ) : (
              <>
                <p>Workout — not placed</p>
                <p>{workoutOutcome.note}</p>
              </>
            ))}
        </>
      )}

      {result.verdict.paidLines.length > 0 && (
        <>
          <h3>Paid</h3>
          {result.verdict.paidLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </>
      )}

      <h3>Fuel — ranked by what the stop really costs</h3>
      <p>
        For {result.fuel.assumptions.gallonsToBuy} gallons at {result.fuel.assumptions.avgMpg} mpg,
        counting detour miles and clock time (an hour priced at{" "}
        {formatMoney(result.fuel.assumptions.valueOfTimeCentsPerHour)}, plus a{" "}
        {result.fuel.assumptions.stopMinutes}-minute stop).
        {result.fuel.assumptions.baselinePriceCents !== null &&
          ` Your average price across your fuel log: ${formatMoney(result.fuel.assumptions.baselinePriceCents)}/gal.`}
        {result.fuel.candidates.some((candidate) => candidate.usedEstimate) &&
          " Prices marked est. are the EIA weekly U.S. average, not that station's price — your fuel log is the only real price here."}
      </p>
      {result.fuel.regional && result.fuel.regional.length > 0 && (
        <ul aria-label="Diesel by region">
          {result.fuel.regional.map((r) => (
            <li key={r.paddCode}>
              {r.regionName}: {formatMoney(r.cents)}/gal — {r.label}
              {r.freshness === "aging" && " (getting old)"}
              {r.freshness === "stale" && " — OLD DATA: shown for reference, not used to rank stops"}
            </li>
          ))}
        </ul>
      )}
      {result.fuel.unavailableReason && <p>{result.fuel.unavailableReason}</p>}
      {result.fuel.candidates.length === 0 && !result.fuel.unavailableReason && (
        <p>No fuel stops found near this route yet — your fuel log and the map data both feed this list.</p>
      )}
      <ul>
        {result.fuel.candidates.map((candidate, i) => (
          <li key={candidate.id}>
            <strong>
              {i < 3 ? `F${i + 1} · ` : ""}
              {candidate.name}
            </strong>{" "}
            {candidate.source === "history" ? "(from your fuel log)" : "(map)"} —{" "}
            {formatFuelPriceLine(candidate)} · {candidate.detourMiles.toFixed(1)} mi detour ·{" "}
            {candidate.effectiveCostCents !== null
              ? `effective cost ${formatMoney(candidate.effectiveCostCents)}`
              : `detour cost ${formatMoney(candidate.detourCostCents)}`}
            {candidate.savingsVsBaselineCents !== null &&
              candidate.savingsVsBaselineCents !== 0 &&
              ` · ${candidate.savingsVsBaselineCents > 0 ? "saves" : "costs"} ${formatMoney(Math.abs(candidate.savingsVsBaselineCents))} vs your average`}
          </li>
        ))}
      </ul>

      <h3>Food — {result.food.mode === "grocery" ? "grocery (cook in the truck)" : "fast food"}</h3>
      {result.food.unavailableReason && <p>Food lookup unavailable: {result.food.unavailableReason}</p>}
      {result.food.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <ul>
        {result.food.stops.map((stop, i) => (
          <li key={stop.id}>
            <strong>
              {i < 3 ? `E${i + 1} · ` : ""}
              {stop.name}
            </strong>{" "}
            — {stop.detourMiles.toFixed(1)} mi off the route · you&apos;d reach it about{" "}
            {formatEastern(new Date(stop.arrivalAt))}
          </li>
        ))}
      </ul>

      {result.warnings.length > 0 && (
        <>
          <h3>Before you roll</h3>
          <ul>
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
