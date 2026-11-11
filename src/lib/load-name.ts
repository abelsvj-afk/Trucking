// How a load is named wherever it is named (owner format, confirmed
// 2026-11-10): the trip number first, then the route —
// "Trip 1874 · Panama City → Seminole". A load with no trip number is
// named by its route alone: no placeholder, no gap. Pure; origin and
// destination are the load's own city strings, exactly as stored.

export interface NameableLoad {
  trip_number?: string | null;
  origin: string;
  destination: string;
}

export function loadRoute(load: NameableLoad): string {
  return `${load.origin} → ${load.destination}`;
}

export function loadDisplayName(load: NameableLoad): string {
  const trip = typeof load.trip_number === "string" ? load.trip_number.trim() : "";
  return trip ? `Trip ${trip} · ${loadRoute(load)}` : loadRoute(load);
}
