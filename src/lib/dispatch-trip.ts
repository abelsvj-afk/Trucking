// Deterministic reader for structured dispatch trip assignments
// ("NEW TRIP 1234 HAS BEEN ASSIGNED", STOP blocks, TRIP DETAILS). Pure.
// The Telegram model extraction missed origin/destination on exactly this
// message (Trip 1234); a structured message should not depend on a model.
// Everything returned is copied from the message text - nothing is guessed:
// a field the message does not carry is simply absent. Messages in other
// shapes (Amazon Relay, free text) return null here and fall through to the
// model extraction, which now knows the same fields.
//
// Trip 1874 repairs (2026-11-09): the reader used to start a stop ONLY on a
// "STOP n" header, so an unnumbered leg headed "LOT TO" kept writing into
// the previous stop and silently overwrote its facility, address and
// appointment (Seminole, OK was erased from Trip 1874). Three structural
// guards now make that class of loss impossible:
//  1. ANY section header ends the current stop block (numbered or not);
//     the header text is kept on the stop as dispatch wrote it.
//  2. A KEY line for a field the current stop already has starts a NEW
//     stop instead of overwriting - a parsed field is never replaced.
//  3. The finished parse is cross-checked against the raw text (every
//     SHIPPER/CONSIGNEE block must land in exactly one stop); any
//     mismatch lands in `warnings`, which the staging path shows the
//     owner and never stages as high-confidence.

import { zonedInstant } from "./zoned-day";

export interface ParsedStop {
  seq: number;
  kind: "pickup" | "delivery" | "other";
  /** The section header exactly as dispatch wrote it ("STOP 2", "LOT TO"), when the block had one. */
  header: string | null;
  name: string | null;
  address: string | null;
  cityState: string | null;
  /** The appointment window start (ISO, UTC) - shown to the owner in the zone below. */
  appointmentAt: string | null;
  /** The appointment window END (ISO, UTC) when the message gives a range ("08:00 CST-16:00 CST"). */
  appointmentEndAt: string | null;
  appointmentTz: string | null;
  /** The wall-clock text exactly as written, e.g. "11/04/2026 00:00 CST" or the full range for a window. */
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
  /**
   * Plain-language problems found by the cross-check (a facility that
   * could not be placed, a stop split by a repeated field). Non-empty =
   * the parse must NOT be presented as high-confidence.
   */
  warnings: string[];
  /** Printed total vs deadhead+loaded, when all three are given and they disagree. Figures stay as printed. */
  milesMismatch: { printedTotal: number; partsSum: number } | null;
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

const APPT_DATETIME = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([A-Za-z]{2,3})?/;
const APPT_TIME_ONLY = /^(\d{1,2}):(\d{2})\s*([A-Za-z]{2,3})?$/;

function apptInstantParts(m: RegExpMatchArray): { date: string; time: string; tz: string | null } {
  const [, mo, d, y, hh, mm, abbr] = m;
  return {
    date: `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`,
    time: `${hh!.padStart(2, "0")}:${mm}`,
    tz: abbr ? (TZ_ABBR[abbr.toUpperCase()] ?? null) : null,
  };
}

function parseAppt(text: string): Pick<ParsedStop, "appointmentAt" | "appointmentEndAt" | "appointmentTz" | "appointmentText"> {
  const m = text.match(APPT_DATETIME);
  if (!m) return { appointmentAt: null, appointmentEndAt: null, appointmentTz: null, appointmentText: text.trim() || null };
  const start = apptInstantParts(m);
  const at = start.tz ? zonedInstant(start.date, start.time, start.tz).toISOString() : null;

  // Window end: whatever follows the start - either a full second
  // datetime ("... CST-11/10/2026 16:00 CST") or a bare end time on
  // the same date ("08:00–16:00 CST", the zone possibly at the end).
  let endAt: string | null = null;
  let endTextEnd: number | null = null;
  let endTz: string | null = null;
  const restStart = (m.index ?? 0) + m[0].length;
  const rest = text.slice(restStart);
  const endFull = rest.match(APPT_DATETIME);
  if (endFull) {
    const end = apptInstantParts(endFull);
    endTz = end.tz ?? start.tz;
    if (endTz) endAt = zonedInstant(end.date, end.time, endTz).toISOString();
    endTextEnd = restStart + (endFull.index ?? 0) + endFull[0].length;
  } else {
    const tail = rest.replace(/^[\s\-–—]+/, "").replace(/^to\s+/i, "");
    const endTime = tail.match(APPT_TIME_ONLY);
    if (endTime) {
      const [, hh, mm, abbr] = endTime;
      endTz = (abbr ? (TZ_ABBR[abbr.toUpperCase()] ?? null) : null) ?? start.tz;
      if (endTz) endAt = zonedInstant(start.date, `${hh!.padStart(2, "0")}:${mm}`, endTz).toISOString();
      endTextEnd = text.length;
    }
  }
  // "08:00-16:00 CST": the only zone written belongs to the whole
  // window - the start takes it too instead of staying zone-less.
  let startAt = at;
  let startTz = start.tz;
  if (startAt === null && startTz === null && endTz !== null) {
    startTz = endTz;
    startAt = zonedInstant(start.date, start.time, endTz).toISOString();
  }
  const appointmentText = (endTextEnd !== null ? text.slice(m.index ?? 0, endTextEnd) : m[0]).trim();
  return { appointmentAt: startAt, appointmentEndAt: endAt, appointmentTz: startTz, appointmentText };
}

function cityStateOf(address: string): string | null {
  const m = address.match(/,\s*([^,]+?)\s*,\s*([A-Z]{2})\s*\d{5}(?:-\d{4})?\s*$/);
  return m ? `${m[1]}, ${m[2]}` : null;
}

/** Strips list markers/emoji from the start of a line. */
function clean(line: string): string {
  return line.replace(/^[\s‍️\p{Extended_Pictographic}]+/u, "").trim();
}

/**
 * A section header that is not "STOP n": a short line with no colon and
 * mostly capital letters - "LOT TO", "DROP AT", "RETURN TO". Slogans
 * after TRIP DETAILS never reach here (details mode), and mixed-case
 * chatter ("No texting while driving") fails the case test.
 */
function isSectionHeader(line: string): boolean {
  if (!line || line.length > 48) return false;
  if (line.includes(":")) return false;
  if (/^[=\-_*#\s]+$/.test(line)) return false;
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  const upper = line.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.6;
}

/** Headers that mark a trailing leg (lot / drop / return / empty move), never the freight delivery itself. */
const AUX_LEG_HEADER = /^(LOT TO|DROP( AT| TO)?|RETURN( TO)?|EMPTY TO|YARD|PARK( AT)?|REPO)\b/i;

export function isAuxLeg(stop: ParsedStop): boolean {
  return stop.header !== null && AUX_LEG_HEADER.test(stop.header);
}

function stopHasContent(s: ParsedStop): boolean {
  return s.name !== null || s.address !== null || s.appointmentText !== null;
}

export function parseDispatchTrip(text: string): ParsedTrip | null {
  const head = text.match(/NEW\s+TRIP\s+#?\s*([A-Za-z0-9-]+)\s+HAS\s+BEEN\s+ASSIGNED/i);
  if (!head) return null;
  const lines = text.split(/\r?\n/);

  const stops: ParsedStop[] = [];
  const warnings: string[] = [];
  let cur: ParsedStop | null = null;
  let inDetails = false;
  const tasks: string[] = [];
  let brokerName: string | null = null;
  let brokerReference: string | null = null;
  let deadhead: number | null = null;
  let loaded: number | null = null;
  let total: number | null = null;

  const newStop = (header: string | null): ParsedStop => {
    const stop: ParsedStop = {
      seq: stops.length + 1, kind: "other", header, name: null, address: null, cityState: null,
      appointmentAt: null, appointmentEndAt: null, appointmentTz: null, appointmentText: null,
    };
    stops.push(stop);
    return stop;
  };

  for (const raw of lines) {
    const line = clean(raw);
    if (/^STOP\s+\d+/i.test(line)) {
      cur = newStop(line.replace(/\s+/g, " ").trim());
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
    // Guard 1: an unnumbered section header ends the current block.
    // Only once the current stop actually holds a stop's worth of
    // fields - a header-shaped line before any field is ignored here
    // (or belongs to the still-empty current stop, which keeps its
    // own numbered header).
    if (!inDetails && cur && stopHasContent(cur) && isSectionHeader(line)) {
      cur = newStop(line.replace(/\s+/g, " ").trim());
      continue;
    }
    const kv = line.match(/^([A-Z/#' .]+?)\s*:\s*(.*)$/i);
    if (!kv) continue;
    const key = kv[1]!.trim().toUpperCase();
    const value = kv[2]!.trim();
    if (cur && !inDetails) {
      // Guard 2: a repeated field never overwrites - it starts the
      // next block (an unnumbered leg whose header line was missed,
      // or a second facility written under the same stop).
      const fieldTaken =
        (key.startsWith("SHIPPER") && cur.name !== null) ||
        (key === "ADDRESS" && cur.address !== null) ||
        (key === "APPT" && cur.appointmentText !== null) ||
        (key === "TYPE" && cur.kind !== "other");
      if (fieldTaken) {
        warnings.push(
          `The message gives a second ${key.startsWith("SHIPPER") ? "facility" : key.toLowerCase()} under stop ${cur.seq}, so I read it as its own stop - check the stops below against the message.`,
        );
        cur = newStop(null);
      }
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

  // Guard 3: cross-check the parse against the raw text. Every
  // SHIPPER/CONSIGNEE block in the source must land in exactly one
  // stop, named as written - a facility that appears in the message
  // but in no stop (or in two) means the parse dropped something.
  const facilityLines: string[] = [];
  for (const raw of lines) {
    const m = clean(raw).match(/^(?:SHIPPER\/CONSIGNEE|CONSIGNEE|SHIPPER)\s*:\s*(.+)$/i);
    if (m) facilityLines.push(m[1]!.trim());
  }
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  for (const facility of facilityLines) {
    // A facility may legitimately be two stops (Trip 1874 picks up at
    // Kontoor Panama City and returns the trailer to the same plant).
    // The failure this guards is a facility placed NOWHERE - dropped
    // or overwritten out of the parse entirely (Seminole, pre-fix).
    const hits = stops.filter((s) => s.name !== null && norm(s.name) === norm(facility)).length;
    if (hits === 0) {
      warnings.push(
        `The message names "${facility}" but I couldn't place it in any stop - check the stops below against the message before you say yes.`,
      );
    }
  }
  const namedStops = stops.filter((s) => s.name !== null).length;
  if (facilityLines.length !== namedStops) {
    warnings.push(
      `The message lists ${facilityLines.length} facilit${facilityLines.length === 1 ? "y" : "ies"} but I read ${namedStops} named stop(s) - something may be missing.`,
    );
  }

  const milesMismatch =
    total !== null && deadhead !== null && loaded !== null && Math.abs(total - (deadhead + loaded)) > 0.005
      ? { printedTotal: total, partsSum: Math.round((deadhead + loaded) * 100) / 100 }
      : null;

  return {
    tripNumber: head[1]!,
    stops,
    brokerName,
    brokerReference,
    deadheadMiles: deadhead,
    loadedMiles: loaded,
    totalMiles: total,
    tasks,
    warnings,
    milesMismatch,
  };
}

/** create_load arguments for a parsed trip. Broker resolution (name -> id) is the caller's, in code. */
export function tripToCreateLoadArgs(trip: ParsedTrip): Record<string, unknown> | null {
  const first = trip.stops[0]!;
  const last = trip.stops[trip.stops.length - 1]!;
  const pickup = trip.stops.find((s) => s.kind === "pickup") ?? first;
  // The headline delivery is the freight delivery - the delivery stop
  // that ends the loaded leg. A later lot/drop/return leg (its own
  // stop, header kept) never takes the headline while a real delivery
  // stop exists (Trip 1874: Seminole delivers the freight; the Panama
  // City lot-to three days later is a stop, not the destination).
  const deliveries = trip.stops.filter((s) => s.kind === "delivery");
  const delivery =
    [...deliveries].reverse().find((s) => !isAuxLeg(s)) ??
    deliveries[deliveries.length - 1] ??
    last;
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
  if (pickup.appointmentEndAt) args.pickup_window_end = pickup.appointmentEndAt;
  if (delivery.appointmentAt) args.delivery_window_start = delivery.appointmentAt;
  if (delivery.appointmentEndAt) args.delivery_window_end = delivery.appointmentEndAt;
  if (pickup.appointmentTz) args.pickup_tz = pickup.appointmentTz;
  if (delivery.appointmentTz) args.delivery_tz = delivery.appointmentTz;
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}
