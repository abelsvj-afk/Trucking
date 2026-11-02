"use client";

// Smart Path v1 (docs/design/driver-mvp.md §8). The parked planning
// surface: pick a load, say when you'd leave, get one verdict -
// legal first, rested second, paid third - with the route, the sleep
// plan, the fuel math, and the food plan on the same screen.
//
// Phone-away law (vision doc §9): nothing here is needed while
// rolling. The verdict block is glance-grade anyway - status and the
// one tradeoff line in large type at the top, detail below - because
// the same block is what the Telegram bot will speak later.

import dynamic from "next/dynamic";
import { Suspense, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import { formatEastern, formatMinutes, routeCaption } from "@/lib/smart-path";
import { formatFuelPriceLine } from "@/lib/smart-path-stops";
import { buildMapStops } from "@/lib/smart-path-map-stops";
import type { Load } from "@/types/entities";
import type { RouteCheckResponse } from "@/types/smart-path";

const SmartPathMap = dynamic(() => import("@/components/SmartPathMap"), { ssr: false });

const STATUS_HEADLINES: Record<RouteCheckResponse["verdict"]["status"], string> = {
  on_time: "ON TIME",
  early: "EARLY",
  late: "LATE",
  not_legal: "NOT LEGAL AS PLANNED",
};

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultDeparture(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(5, 0, 0, 0);
  return d;
}

function windowDefault(dateStr: string | null, startHour: number, endHour: number): { start: string; end: string } {
  if (!dateStr) return { start: "", end: "" };
  const [y, m, d] = dateStr.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: `${y}-${pad(m ?? 1)}-${pad(d ?? 1)}T${pad(startHour)}:00`,
    end: `${y}-${pad(m ?? 1)}-${pad(d ?? 1)}T${pad(endHour)}:00`,
  };
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

export default function SmartPathPage() {
  return (
    <Suspense fallback={<ListLoading />}>
      <SmartPathInner />
    </Suspense>
  );
}

interface WindowValues {
  pickupStart: string;
  pickupEnd: string;
  deliveryStart: string;
  deliveryEnd: string;
}

function SmartPathInner() {
  usePageTitle("Smart Path");
  const searchParams = useSearchParams();
  const { state: loadsState, retry } = useApiList<Load>("loads");

  // Selection and window defaults are DERIVED, not effect-synced (the
  // repo's lint bans setState-in-effect): the override states hold
  // only what the owner actually picked/typed; everything else falls
  // back to the query param, the first load, or the load's dates.
  const [loadIdOverride, setLoadIdOverride] = useState<string | null>(null);
  const [departAt, setDepartAt] = useState(() => toLocalInputValue(defaultDeparture()));
  const [windowEdits, setWindowEdits] = useState<(WindowValues & { loadId: string }) | null>(null);
  const [foodMode, setFoodMode] = useState<"grocery" | "fast_food">("grocery");
  const [gallons, setGallons] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RouteCheckResponse | null>(null);
  // Piece 1 (P1-7): the deadhead start - typed place, or a one-shot
  // geolocation fix from the "Use where I am" button. Never watched,
  // never persisted; it only rides along on the check itself.
  const [startText, setStartText] = useState("");
  const [startPoint, setStartPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [startGeoMessage, setStartGeoMessage] = useState<string | null>(null);
  const [startAt, setStartAt] = useState("");
  // Piece 1 (P1-9): life preferences for this run - sleep window and
  // an optional workout break. Empty select = no set window.
  const [sleepStartHour, setSleepStartHour] = useState("");
  const [sleepEndHour, setSleepEndHour] = useState("");
  const [workoutWant, setWorkoutWant] = useState(false);
  const [workoutMinutes, setWorkoutMinutes] = useState(60);
  const [workoutSetting, setWorkoutSetting] = useState<"gym_preferred" | "any_safe_stop">(
    "gym_preferred",
  );

  const loads = useMemo(
    () => (loadsState.status === "loaded" ? loadsState.result.data : []),
    [loadsState],
  );
  const queryLoadId = searchParams.get("load_id");
  const loadId =
    loadIdOverride ??
    (queryLoadId && loads.some((load) => load.id === queryLoadId) ? queryLoadId : loads[0]?.id ?? "");
  const selectedLoad = loads.find((load) => load.id === loadId) ?? null;

  const windowDefaults: WindowValues = useMemo(() => {
    if (!selectedLoad) return { pickupStart: "", pickupEnd: "", deliveryStart: "", deliveryEnd: "" };
    const pickup = windowDefault(selectedLoad.pickup_date, 6, 12);
    const delivery = windowDefault(selectedLoad.delivery_date, 8, 17);
    return {
      pickupStart: pickup.start,
      pickupEnd: pickup.end,
      deliveryStart: delivery.start,
      deliveryEnd: delivery.end,
    };
  }, [selectedLoad]);
  const windows: WindowValues =
    windowEdits && windowEdits.loadId === loadId ? windowEdits : windowDefaults;
  const setWindow = (patch: Partial<WindowValues>) => {
    if (!selectedLoad) return;
    setWindowEdits({ ...windows, ...patch, loadId: selectedLoad.id });
  };
  const { pickupStart, pickupEnd, deliveryStart, deliveryEnd } = windows;

  const startIsSet = startPoint !== null || startText.trim().length > 0;

  // The only geolocation in the page: one-shot, on tap, foreground.
  function handleUseMyLocation() {
    if (!navigator.geolocation) {
      setStartGeoMessage("Couldn't get your location — type the start place instead.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setStartPoint({ lat: position.coords.latitude, lng: position.coords.longitude });
        setStartGeoMessage(
          `Using your current location (±${Math.round(position.coords.accuracy)} m) — or type a place instead.`,
        );
      },
      () => {
        setStartGeoMessage("Couldn't get your location — type the start place instead.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loadId) return;
    setError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        load_id: loadId,
        depart_at: new Date(departAt).toISOString(),
        food_mode: foodMode,
      };
      if (pickupStart && pickupEnd) {
        body.pickup_window = {
          start: new Date(pickupStart).toISOString(),
          end: new Date(pickupEnd).toISOString(),
        };
      }
      if (deliveryStart && deliveryEnd) {
        body.delivery_window = {
          start: new Date(deliveryStart).toISOString(),
          end: new Date(deliveryEnd).toISOString(),
        };
      }
      const gallonsNumber = Number(gallons);
      if (gallons && Number.isFinite(gallonsNumber) && gallonsNumber > 0) {
        body.gallons_to_buy = gallonsNumber;
      }
      if (startPoint) {
        body.start_point = startPoint;
      } else if (startText.trim()) {
        body.start_location = startText.trim();
      }
      if (startIsSet && startAt) {
        body.start_at = new Date(startAt).toISOString();
      }
      const life: Record<string, unknown> = {};
      if (sleepStartHour !== "") life.sleep_start_hour = Number(sleepStartHour);
      if (sleepEndHour !== "") life.sleep_end_hour = Number(sleepEndHour);
      if (workoutWant) {
        life.workout = { want: true, minutes: workoutMinutes, setting: workoutSetting };
      }
      if (Object.keys(life).length > 0) {
        body.life = life;
      }
      const response = await apiClient.create<RouteCheckResponse>("smart-path/route-check", body);
      setResult(response);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The route check failed. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const mapStops = useMemo(
    () => (result ? buildMapStops(result, { workoutSetting }) : []),
    [result, workoutSetting],
  );

  const caption = result
    ? `Map © OpenStreetMap contributors. ${routeCaption(result.route)}`
    : "Map © OpenStreetMap contributors. When you check a run, this line says which engine drew the route and whether it was truck-checked.";

  const workoutOutcome = result?.plan?.workout ?? null;
  // The workout block below renders plan.workout's own line, so a
  // lifeLine that already says it ("Workout: …") is not repeated.
  const lifeLinesToRender = result
    ? workoutOutcome
      ? result.verdict.lifeLines.filter((line) => !line.startsWith("Workout:"))
      : result.verdict.lifeLines
    : [];

  const mapsHandoff =
    selectedLoad &&
    `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(selectedLoad.origin)}&destination=${encodeURIComponent(selectedLoad.destination)}`;

  return (
    <div>
      <PageHeader title="Smart Path" purpose="One route, checked three ways — legal first (your hours), rested second, paid third — with fuel and food that fit the truck." />
      <p>
        One plan for the whole run — legal first, rested second, paid third. Times are Eastern.
        Plan while you&apos;re parked; on the road, the bot speaks the plan.
      </p>

      <SmartPathMap
        geometry={result?.route.geometry ?? []}
        stops={mapStops}
        deadheadGeometry={result?.deadhead?.geometry ?? []}
        caption={caption}
      />

      {loadsState.status === "loading" && <ListLoading />}
      {loadsState.status === "error" && <ListError message={loadsState.message} onRetry={retry} />}
      {loadsState.status === "loaded" && loads.length === 0 && (
        <p>No loads yet — add a load first, then check its run here.</p>
      )}

      {loads.length > 0 && (
        <form onSubmit={handleSubmit}>
          <h2>Check a run</h2>

          <label htmlFor="load_id">Load</label>
          <select id="load_id" value={loadId} onChange={(event) => setLoadIdOverride(event.target.value)}>
            {loads.map((load) => (
              <option key={load.id} value={load.id}>
                {load.origin} → {load.destination} ({load.status})
              </option>
            ))}
          </select>

          <fieldset>
            <legend>The whole run</legend>
            <label htmlFor="start_location">Starting from (optional)</label>
            <input
              id="start_location"
              type="text"
              placeholder="e.g. Melbourne, FL — where you are before the pickup"
              value={startText}
              onChange={(event) => {
                setStartText(event.target.value);
                if (startPoint) {
                  setStartPoint(null);
                  setStartGeoMessage(null);
                }
              }}
            />
            <button type="button" onClick={handleUseMyLocation}>
              Use where I am
            </button>
            {startGeoMessage && <p>{startGeoMessage}</p>}
            {startIsSet && (
              <>
                <label htmlFor="start_at">Leaving the start at (optional)</label>
                <input
                  id="start_at"
                  type="datetime-local"
                  value={startAt}
                  onChange={(event) => setStartAt(event.target.value)}
                />
                <p>Leave blank to get the just-in-time leave-by time.</p>
              </>
            )}
          </fieldset>

          <label htmlFor="depart_at">Leaving the pickup (loaded) at</label>
          <input
            id="depart_at"
            type="datetime-local"
            value={departAt}
            onChange={(event) => setDepartAt(event.target.value)}
            required
          />

          <fieldset>
            <legend>Pickup window (adjust to the real appointment)</legend>
            <label htmlFor="pickup_start">Opens</label>
            <input id="pickup_start" type="datetime-local" value={pickupStart} onChange={(e) => setWindow({ pickupStart: e.target.value })} />
            <label htmlFor="pickup_end">Closes</label>
            <input id="pickup_end" type="datetime-local" value={pickupEnd} onChange={(e) => setWindow({ pickupEnd: e.target.value })} />
          </fieldset>

          <fieldset>
            <legend>Delivery window (adjust to the real appointment)</legend>
            <label htmlFor="delivery_start">Opens</label>
            <input id="delivery_start" type="datetime-local" value={deliveryStart} onChange={(e) => setWindow({ deliveryStart: e.target.value })} />
            <label htmlFor="delivery_end">Closes</label>
            <input id="delivery_end" type="datetime-local" value={deliveryEnd} onChange={(e) => setWindow({ deliveryEnd: e.target.value })} />
          </fieldset>

          <fieldset>
            <legend>Food on this run</legend>
            <label>
              <input type="radio" name="food_mode" checked={foodMode === "grocery"} onChange={() => setFoodMode("grocery")} />{" "}
              Grocery — I cook in the truck
            </label>
            <label>
              <input type="radio" name="food_mode" checked={foodMode === "fast_food"} onChange={() => setFoodMode("fast_food")} />{" "}
              Fast food — no time to stop properly
            </label>
          </fieldset>

          <fieldset>
            <legend>Your life on this run</legend>
            <label htmlFor="sleep_start_hour">Sleep window starts</label>
            <select
              id="sleep_start_hour"
              value={sleepStartHour}
              onChange={(event) => setSleepStartHour(event.target.value)}
            >
              <option value="">No set window</option>
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {hourLabel(hour)}
                </option>
              ))}
            </select>
            <label htmlFor="sleep_end_hour">Sleep window ends</label>
            <select
              id="sleep_end_hour"
              value={sleepEndHour}
              onChange={(event) => setSleepEndHour(event.target.value)}
            >
              <option value="">No set window</option>
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {hourLabel(hour)}
                </option>
              ))}
            </select>
            <label>
              <input
                type="checkbox"
                checked={workoutWant}
                onChange={(event) => setWorkoutWant(event.target.checked)}
              />{" "}
              Try to fit a workout break
            </label>
            {workoutWant && (
              <>
                <label htmlFor="workout_minutes">Workout minutes</label>
                <input
                  id="workout_minutes"
                  type="number"
                  min="30"
                  max="180"
                  value={workoutMinutes}
                  onChange={(event) => setWorkoutMinutes(Number(event.target.value))}
                />
                <label htmlFor="workout_setting">Workout spot</label>
                <select
                  id="workout_setting"
                  value={workoutSetting}
                  onChange={(event) =>
                    setWorkoutSetting(event.target.value as "gym_preferred" | "any_safe_stop")
                  }
                >
                  <option value="gym_preferred">A gym if one&apos;s near</option>
                  <option value="any_safe_stop">Any safe stop (bodyweight)</option>
                </select>
              </>
            )}
          </fieldset>

          <label htmlFor="gallons">Gallons I plan to buy (optional)</label>
          <input id="gallons" type="number" min="1" max="300" value={gallons} onChange={(e) => setGallons(e.target.value)} />

          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? "Checking…" : "Check this run"}
          </button>
          {mapsHandoff && (
            <p>
              <a href={mapsHandoff} target="_blank" rel="noreferrer">
                Open this lane in Google Maps (handoff)
              </a>
            </p>
          )}
        </form>
      )}

      {result && (
        <section aria-label="Route check result">
          <h2>
            {result.load.origin} → {result.load.destination}
          </h2>
          <p style={{ fontSize: "1.6rem", fontWeight: 800 }}>
            {STATUS_HEADLINES[result.verdict.status]}
          </p>
          {result.verdict.tradeoffLines.map((line) => (
            <p key={line} style={{ fontSize: "1.25rem", fontWeight: 600 }}>
              {line}
            </p>
          ))}
          <p>
            {Math.round(result.route.distanceMiles)} miles · drive time planned at{" "}
            {formatMinutes(result.verdict.assumedDriveMinutes)} ({result.verdict.driveTimeBasis})
            {result.plan?.arrivalAt && <> · arrival {formatEastern(new Date(result.plan.arrivalAt))}</>}
          </p>
          <p>{routeCaption(result.route)}</p>

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
            {dollars(result.fuel.assumptions.valueOfTimeCentsPerHour)}, plus a{" "}
            {result.fuel.assumptions.stopMinutes}-minute stop).
            {result.fuel.assumptions.baselinePriceCents !== null &&
              ` Your average price across your fuel log: ${dollars(result.fuel.assumptions.baselinePriceCents)}/gal.`}
            {result.fuel.candidates.some((candidate) => candidate.usedEstimate) &&
              " Prices marked est. are the EIA weekly U.S. average, not that station's price — your fuel log is the only real price here."}
          </p>
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
                  ? `effective cost ${dollars(candidate.effectiveCostCents)}`
                  : `detour cost ${dollars(candidate.detourCostCents)}`}
                {candidate.savingsVsBaselineCents !== null &&
                  candidate.savingsVsBaselineCents !== 0 &&
                  ` · ${candidate.savingsVsBaselineCents > 0 ? "saves" : "costs"} ${dollars(Math.abs(candidate.savingsVsBaselineCents))} vs your average`}
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
        </section>
      )}
    </div>
  );
}
