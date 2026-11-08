// Smart Path Piece 1 (P1-2): the pure assembly of map stops from a
// route-check response. Kept out of the page so the badge numbering,
// popup lines, and stacking order are unit-testable without
// rendering. Stacking order is the array order: fuel, food, rests,
// workout, origin, destination, start - the map creates markers in
// array order, so the important pins (pickup/delivery/start) land on
// top.

import { formatEastern, type LatLng } from "./smart-path";
import { formatFuelPriceLine } from "./smart-path-stops";
import type { SmartPathMapStop } from "@/components/SmartPathMap";
import type { RouteCheckResponse } from "@/types/smart-path";

function mapsUrlFor(point: LatLng): string {
  return `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function buildMapStops(
  result: RouteCheckResponse,
  opts?: { workoutSetting?: "gym_preferred" | "any_safe_stop" },
): SmartPathMapStop[] {
  const stops: SmartPathMapStop[] = [];

  result.fuel.candidates.slice(0, 3).forEach((candidate, i) => {
    const point = { lat: candidate.lat, lng: candidate.lng };
    stops.push({
      id: candidate.id,
      kind: "fuel",
      point,
      badge: `F${i + 1}`,
      color: "#b45309",
      title: candidate.name,
      lines: [
        formatFuelPriceLine(candidate),
        `${candidate.detourMiles.toFixed(1)} mi detour`,
        candidate.effectiveCostCents !== null
          ? `effective cost ${dollars(candidate.effectiveCostCents)}`
          : `detour cost ${dollars(candidate.detourCostCents)}`,
      ],
      mapsUrl: mapsUrlFor(point),
    });
  });

  result.food.stops.slice(0, 3).forEach((stop, i) => {
    const point = { lat: stop.lat, lng: stop.lng };
    stops.push({
      id: stop.id,
      kind: "food",
      point,
      badge: `E${i + 1}`,
      color: "#7c3aed",
      title: stop.name,
      lines: [
        `${stop.detourMiles.toFixed(1)} mi off the route`,
        `You'd reach it about ${formatEastern(new Date(stop.arrivalAt))}`,
      ],
      mapsUrl: mapsUrlFor(point),
    });
  });

  const rests = (result.plan?.rests ?? []).filter((rest) => rest.point !== null);
  rests.forEach((rest, i) => {
    const point = rest.point!;
    stops.push({
      id: `rest-${i}`,
      kind: "rest",
      point,
      badge: `S${i + 1}`,
      color: "#3f3f46",
      title: "Sleep stop",
      lines: [
        `Near mile ${rest.distanceMilesFromOrigin}`,
        `Starts ${formatEastern(new Date(rest.startAt))}`,
      ],
      mapsUrl: mapsUrlFor(point),
    });
  });

  const workout = result.plan?.workout;
  if (workout?.placed && workout.point) {
    stops.push({
      id: "workout",
      kind: "workout",
      point: workout.point,
      badge: "W1",
      color: "#e11d48",
      title: workout.placeName ?? "Workout stop",
      lines: [
        `Workout — ${workout.durationMinutes} min`,
        ...(workout.startAt
          ? [`Starts ${formatEastern(new Date(workout.startAt))}`]
          : []),
        ...(workout.placeKind !== "gym" && opts?.workoutSetting === "gym_preferred"
          ? ["No gym near this stop — it's a bodyweight spot; your normal session works here."]
          : []),
      ],
      mapsUrl: mapsUrlFor(workout.point),
    });
  }

  stops.push({
    id: "origin",
    kind: "origin",
    point: result.route.originPoint,
    badge: "A",
    color: "#15803d",
    title: result.load.origin,
    lines: ["Pickup"],
    mapsUrl: mapsUrlFor(result.route.originPoint),
  });

  stops.push({
    id: "destination",
    kind: "destination",
    point: result.route.destinationPoint,
    badge: "B",
    color: "#b91c1c",
    title: result.load.destination,
    lines: ["Delivery"],
    mapsUrl: mapsUrlFor(result.route.destinationPoint),
  });

  if (result.deadhead) {
    const deadhead = result.deadhead;
    stops.push({
      id: "start",
      kind: "start",
      point: deadhead.startPoint,
      badge: "START",
      color: "#0f766a",
      title: `Start — ${deadhead.startLabel}`,
      lines: [
        `${deadhead.distanceMiles} mi to the pickup`,
        `Leave by ${formatEastern(new Date(deadhead.leaveByAt))}`,
      ],
      mapsUrl: mapsUrlFor(deadhead.startPoint),
    });
  }

  return stops;
}
