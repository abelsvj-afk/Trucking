// Deterministic reader for structured dispatch trip assignments
// ("NEW TRIP 1852 HAS BEEN ASSIGNED", STOP blocks, TRIP DETAILS). Pure.
// The Telegram model extraction missed origin/destination on exactly this
// message (Trip 1852); a structured message should not depend on a model.
// Everything returned is copied from the message text - nothing is guessed:
// a field the message does not carry is simply absent. Messages in other
// shapes (Amazon Relay, free text) return null here and fall through to the
// model extraction, which now knows the same fields.

import { zonedInstant } from "./zoned-day";

export interface ParsedStop {
  seq: number;
  kind: "pickup" | "delivery" | "other";
  name: string | null;
  address: string | null;
  cityState: string | null;
  /** The appointment instant (ISO, UTC) - shown to the owner in the zone below. */
  appointmentAt: string | null;
  appointmentTz: string | null;
  /** The wall-clock text exactly as written, e.g. "11/04/2026 00:00 CST". */
  appointmentText: string | null;
}

export interface ParsedTrip {
  tripNumber: string;
  stops: ParsedStop[];
  brokerName: string | null;
  brokerReference: string | null;
  deadheadMiles: number | null;
  loadedMiles: number | null;
  totalMiles: number | null;
  /** The dispatcher's requirement lines (the ❗ lines), verbatim minus the marker. */
  tasks: string[];
}

/** US zone abbreviations dispatch uses -> IANA zone (DST handled by the zone itself). */
const TZ_ABBR: Record<string, string> = {
  EST: "America/New_York", EDT: "America/New_York", ET: "America/New_York",
  CST: "America/Chicago", CDT: "America/Chicago", CT: "America/Chicago",
  MST: "America/Denver", MDT: "America/Denver", MT: "America/Denver",
  PST: "America/Los_Angeles", PDT: "America/Los_Angeles", PT: "America/Los_Angeles",
};

function num(raw: string): number | null {
  const n = Number.parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseAppt(text: string): Pick<ParsedStop, "appointmentAt" | "appointmentTz" | "appointmentText"> {
  const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([A-Za-z]{2,3})?/);
  if (!m) return { appointmentAt: null, appointmentTz: null, appointmentText: text.trim() || null };
  const [, mo, d, y, hh, mm, abbr] = m;
  const tz = abbr ? (TZ_ABBR[abbr.toUpperCase()] ?? null) : null;
  const date = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  const time = `${hh!.padStart(2, "0")}:${mm}`;
  // Without a recognizable zone the wall time cannot be turned into an instant honestly.
  const at = tz ? zonedInstant(date, time, tz).toISOString() : null;
  return { appointmentAt: at, appointmentTz: tz, appointmentText: m[0].trim() };
}

function cityStateOf(address: string): string | null {
  const m = address.match(/,\s*([^,]+?)\s*,\s*([A-Z]{2})\s*\d{5}(?:-\d{4})?\s*$/);
  return m ? `${m[1]}, ${m[2]}` : null;
}

/** Strips list markers/emoji from the start of a line. */
function clean(line: string): string {
  return line.replace(/^[\s‍️\p{Extended_Pictographic}]+/u, "").trim();
}

export function parseDispatchTrip(text: string): ParsedTrip | null {
  const head = text.match(/NEW\s+TRIP\s+#?\s*([A-Za-z0-9-]+)\s+HAS\s+BEEN\s+ASSIGNED/i);
  if (!head) return null;
  const lines = text.split(/\r?\n/);

  const stops: ParsedStop[] = [];
  let cur: ParsedStop | null = null;
  let inDetails = false;
  const tasks: string[] = [];
  let brokerName: string | null = null;
  let brokerReference: string | null = null;
  let deadhead: number | null = null;
  let loaded: number | null = null;
  let total: number | null = null;

  for (const raw of lines) {
    const line = clean(raw);
    if (/^STOP\s+\d+/i.test(line)) {
      cur = { seq: stops.length + 1, kind: "other", name: null, address: null, cityState: null, appointmentAt: null, appointmentTz: null, appointmentText: null };
      stops.push(cur);
      inDetails = false;
      continue;
    }
    if (/^TRIP\s+DETAILS/i.test(line)) {
      cur = null;
      inDetails = true;
      continue;
    }
    if (raw.trim().startsWith("❗")) {
      const t = clean(raw.replace(/^[\s]*❗️?/, ""));
      if (t) tasks.push(t);
      continue;
    }
    const kv = line.match(/^([A-Z/#' .]+?)\s*:\s*(.*)$/i);
    if (!kv) continue;
    const key = kv[1]!.trim().toUpperCase();
    const value = kv[2]!.trim();
    if (cur && !inDetails) {
      if (key.startsWith("SHIPPER")) cur.name = value || null;
      else if (key === "ADDRESS") {
        cur.address = value.replace(/\s+,/g, ",") || null;
        cur.cityState = cur.address ? cityStateOf(cur.address) : null;
      } else if (key === "APPT") Object.assign(cur, parseAppt(value));
      else if (key === "TYPE") cur.kind = /pickup/i.test(value) ? "pickup" : /deliver/i.test(value) ? "delivery" : "other";
    } else if (inDetails) {
      if (key === "BROKER") brokerName = value || null;
      else if (key.startsWith("REF")) brokerReference = value || null;
      else if (key === "DEADHEAD") deadhead = num(value);
      else if (key.startsWith("LOADED")) loaded = num(value);
      else if (key.startsWith("TOTAL")) total = num(value);
    }
  }
  if (stops.length === 0) return null;
  return {
    tripNumber: head[1]!,
    stops,
    brokerName,
    brokerReference,
    deadheadMiles: deadhead,
    loadedMiles: loaded,
    totalMiles: total,
    tasks,
  };
}

/** create_load arguments for a parsed trip. Broker resolution (name -> id) is the caller's, in code. */
export function tripToCreateLoadArgs(trip: ParsedTrip): Record<string, unknown> | null {
  const first = trip.stops[0]!;
  const last = trip.stops[trip.stops.length - 1]!;
  const pickup = trip.stops.find((s) => s.kind === "pickup") ?? first;
  const delivery = [...trip.stops].reverse().find((s) => s.kind === "delivery") ?? last;
  const origin = pickup.cityState ?? pickup.address;
  const destination = delivery.cityState ?? delivery.address;
  if (!origin || !destination) return null;
  const dateOf = (s: ParsedStop) => {
    const m = s.appointmentText?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : undefined;
  };
  const args: Record<string, unknown> = {
    origin,
    destination,
    trip_number: trip.tripNumber,
    tasks: trip.tasks.length > 0 ? trip.tasks : undefined,
    stops: trip.stops.map((s) => ({
      seq: s.seq, kind: s.kind, name: s.name ?? undefined, address: s.address ?? undefined,
      appointment_at: s.appointmentAt ?? undefined, appointment_tz: s.appointmentTz ?? undefined,
    })),
  };
  if (trip.brokerReference) args.broker_reference = trip.brokerReference;
  if (trip.deadheadMiles !== null) args.deadhead_miles = trip.deadheadMiles;
  if (trip.loadedMiles !== null) args.loaded_miles = trip.loadedMiles;
  if (trip.totalMiles !== null) args.miles = Math.round(trip.totalMiles);
  const pd = dateOf(pickup);
  const dd = dateOf(delivery);
  if (pd) args.pickup_date = pd;
  if (dd) args.delivery_date = dd;
  if (pickup.appointmentAt) args.pickup_window_start = pickup.appointmentAt;
  if (delivery.appointmentAt) args.delivery_window_start = delivery.appointmentAt;
  if (pickup.appointmentTz) args.pickup_tz = pickup.appointmentTz;
  if (delivery.appointmentTz) args.delivery_tz = delivery.appointmentTz;
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}
