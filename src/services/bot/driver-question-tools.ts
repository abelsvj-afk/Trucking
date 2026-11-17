// Tools for the questions every kind of driver asks (owner 2026-11-07;
// docs/design/fleet-learning-and-driver-questions.md section 6): "is this rate good", "can I make the appointment",
// "what do I do if...". All READ tools; numbers are computed in code, the guidance is fixed reviewed text.

import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { todayEastern } from "@/lib/eastern-date";
import { resolveWhen } from "@/lib/temporal";
import { formatLaneStats, laneStats, type LaneLoad } from "@/lib/lane-stats";
import { DEFAULT_MPH, describeTripPlan, easternToEpoch, parseClock, planTrip, type Clocks } from "@/lib/trip-plan";
import { evaluatePlan, formatPlanVerdict, segmentsFromLogs, type PlanEventInput, type PlanWindows } from "@/lib/plan-check";
import type { Segment } from "@/lib/hos";
import { pickActiveLoad } from "@/lib/active-load";
import type { Load, LoadStop } from "@/types/entities";
import { REFERENCE_TOPICS, findReference, formatReference } from "@/lib/quick-reference";
import { loadHosWindow } from "@/services/api/hos-window";
import { glanceFromSnapshot } from "@/services/api/pay-summary";

export function buildDriverQuestionTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;
  return [
    {
      name: "lane_rate_history",
      description:
        "What HE has actually been paid per mile on a lane, from his own booked and finished loads: how many loads, average, median, range, the most recent ones and whether recent loads run above or below his average. origin and destination are states ('GA', 'Florida') or cities ('Macon, GA'); leave one out for 'anywhere'. Use for 'is this rate good', 'what do I usually get from Atlanta to Dallas', and before countering an offer. It is HIS history, not the market - and with few loads it says so.",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Pickup state or city, or omit for anywhere." },
          destination: { type: "string", description: "Delivery state or city, or omit for anywhere." },
        },
      },
      access: "read",
      async run(args) {
        const origin = typeof args.origin === "string" && args.origin.trim() ? args.origin.trim() : null;
        const destination = typeof args.destination === "string" && args.destination.trim() ? args.destination.trim() : null;
        if (!origin && !destination) return "Tell me at least one end of the lane (a state or a city).";
        const { data, error } = await client
          .from("loads")
          .select("origin, destination, origin_state, destination_state, rate_cents, miles, pickup_date, delivery_date")
          .eq("company_id", companyId)
          .in("status", ["confirmed", "completed"])
          .is("deleted_at", null)
          .limit(500);
        if (error) throw new Error(error.message);
        return formatLaneStats(origin, destination, laneStats((data ?? []) as LaneLoad[], origin, destination));
      },
    },
    {
      name: "delivery_feasibility",
      description:
        "Can he make it, and when will he arrive? Takes the miles and (optionally) an appointment, and simulates the drive against his CURRENT hours-of-service clocks - the 11-hour driving limit, the 14-hour window, the 30-minute break after 8 hours, 10-hour resets, and the cycle when known. Says when he arrives, where breaks and resets land, and whether an appointment is reachable (with the margin or how late). Planning arithmetic: traffic, weather, fuel and dock time are NOT included, and it says so. Use for 'can I make the 8 AM', 'when would I get there', 'will my hours let me'. appointment_date is a date or phrase ('tomorrow', 'friday'); appointment_time like '8am' or '14:30' (Eastern).",
      parameters: {
        type: "object",
        properties: {
          miles: { type: "number", description: "Miles still to drive." },
          appointment_date: { type: "string", description: "Date or phrase, e.g. 'tomorrow', 'friday', '2026-11-09'." },
          appointment_time: { type: "string", description: "Time, e.g. '8am', '14:30' (Eastern)." },
          avg_mph: { type: "number", description: `Average speed including normal traffic (default ${DEFAULT_MPH}).` },
        },
        required: ["miles"],
      },
      access: "read",
      async run(args) {
        const miles = Number(args.miles);
        if (!Number.isFinite(miles) || miles <= 0 || miles > 5000) return "Tell me how many miles are left (more than 0, up to 5,000).";
        const mph = typeof args.avg_mph === "number" && args.avg_mph >= 20 && args.avg_mph <= 80 ? args.avg_mph : DEFAULT_MPH;
        const now = Date.now();

        let appointment: number | null = null;
        if (typeof args.appointment_time === "string" || typeof args.appointment_date === "string") {
          const clock = typeof args.appointment_time === "string" ? parseClock(args.appointment_time) : null;
          if (typeof args.appointment_time === "string" && !clock) return `I can't read "${args.appointment_time}" as a time - try "8am" or "14:30".`;
          const when = resolveWhen(typeof args.appointment_date === "string" && args.appointment_date.trim() ? args.appointment_date : "today", todayEastern());
          if (!when.ok) return `Appointment date: ${when.error}`;
          if (!clock) return "I have the date but not the time of the appointment - give me both (for example tomorrow at 8am).";
          appointment = easternToEpoch(when.date, clock.hour, clock.minute);
          if (appointment === null) return "I couldn't place that appointment time.";
        }

        let clocks: Clocks | null = null;
        try {
          const snapshot = await loadHosWindow(client, companyId, new Date(now));
          const glance = snapshot ? glanceFromSnapshot(snapshot, now) : null;
          if (glance) clocks = { driveLeftMs: glance.driveLeftMs, windowLeftMs: glance.windowLeftMs, breakDueInMs: glance.breakDueInMs, cycleLeftMs: glance.cycleLeftMs };
        } catch {
          clocks = null;
        }
        const plan = planTrip(miles, mph, now, clocks);
        return describeTripPlan(plan, now, miles, mph, appointment, clocks !== null);
      },
    },
    {
      name: "evaluate_plan",
      description:
        "How does a plan he describes fit his hours and his load? Takes the plan as an ordered list of events — each with the drive minutes to reach it (from active_load_status / check_route, never estimated), the minutes stopped there, whether the stop is rest (off duty or sleeper), and any 'by' time — and checks it against his CURRENT hours-of-service clocks (the same snapshot the app shows), the 60/70-hour cycle, and the active load's pickup and delivery appointments. Answers fits, does not fit, or fits with a split sleeper break (and what the break buys him). Use whenever he describes a plan in plain words: 'I want to stop at X before the drop', 'can I sleep at Y tonight and drop in the morning', 'how does this fit my drive time / delivery window'. Get drive minutes from the route tools first; if a leg has no drive time, say which one instead of guessing.",
      parameters: {
        type: "object",
        properties: {
          events: {
            type: "array",
            description: "The plan in order.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "What he wants to do there, in his words." },
                drive_minutes: { type: "number", description: "Driving minutes to reach this event from the previous point (from a route tool — never estimated)." },
                dwell_minutes: { type: "number", description: "Minutes stopped at the event." },
                rest_kind: { type: "string", enum: ["off_duty", "sleeper"], description: "The stop is rest of this kind." },
                arrive_by: { type: "string", description: "Latest arrival — ISO timestamp, or a clock time like '9pm' (Eastern)." },
                arrive_after: { type: "string", description: "Earliest arrival — ISO timestamp, or a clock time (Eastern)." },
                load_stop: { type: "string", enum: ["pickup", "delivery"], description: "This event IS that stop on the active load." },
              },
              required: ["label", "drive_minutes", "dwell_minutes"],
            },
          },
          load_id: { type: "string", description: "Only if he names a different load (uuid from list_loads). Defaults to the active load." },
        },
        required: ["events"],
      },
      access: "read",
      async run(args) {
        const rawEvents = Array.isArray(args.events) ? args.events : [];
        if (rawEvents.length === 0) return "Tell me the plan as a list of stops — where, how long you drive to get there, and how long you stay.";
        const now = Date.now();
        const resolveTime = (value: unknown): number | null | string => {
          if (value == null) return null;
          if (typeof value !== "string" || !value.trim()) return null;
          const iso = Date.parse(value);
          if (Number.isFinite(iso)) return iso;
          const clock = parseClock(value);
          if (!clock) return `I can't read "${value}" as a time - try "9pm" or an ISO timestamp.`;
          const today = todayEastern();
          let epoch = easternToEpoch(today, clock.hour, clock.minute);
          if (epoch === null) return `I couldn't place "${value}" as a time.`;
          if (epoch < now) {
            const tomorrow = new Date(new Date(`${today}T12:00:00Z`).getTime() + 24 * 60 * 60_000).toISOString().slice(0, 10);
            epoch = easternToEpoch(tomorrow, clock.hour, clock.minute) ?? epoch;
          }
          return epoch;
        };
        const events: PlanEventInput[] = [];
        for (const raw of rawEvents as Record<string, unknown>[]) {
          const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : "a stop";
          const drive = Number(raw.drive_minutes);
          const dwell = Number(raw.dwell_minutes);
          if (!Number.isFinite(drive) || drive < 0 || drive > 60 * 24 * 3) return `I need the drive minutes to "${label}" — get them from the route first (active_load_status), don't guess.`;
          if (!Number.isFinite(dwell) || dwell < 0 || dwell > 60 * 24 * 3) return `How long are you stopped at "${label}"? Give me the minutes.`;
          const arriveBy = resolveTime(raw.arrive_by);
          if (typeof arriveBy === "string") return arriveBy;
          const arriveAfter = resolveTime(raw.arrive_after);
          if (typeof arriveAfter === "string") return arriveAfter;
          const restKind = raw.rest_kind === "off_duty" || raw.rest_kind === "sleeper" ? raw.rest_kind : null;
          const loadStop = raw.load_stop === "pickup" || raw.load_stop === "delivery" ? raw.load_stop : null;
          events.push({ label, driveMinutes: drive, dwellMinutes: dwell, restKind, arriveByMs: arriveBy, arriveAfterMs: arriveAfter, loadStop });
        }

        // His clocks — the same snapshot the app shows. A failed read
        // is reported plainly; no logs at all means full hours, said
        // out loud (the delivery_feasibility convention).
        let snapshot = null;
        try {
          snapshot = await loadHosWindow(client, companyId, new Date(now));
        } catch {
          return "Your hours couldn't be read just now — the duty-log window failed to load. Say that plainly; don't guess the clocks.";
        }
        const glance = snapshot ? glanceFromSnapshot(snapshot, now) : null;
        let clocks;
        let assumedFull = false;
        let segments: Segment[] = [];
        if (snapshot && glance) {
          clocks = { driveLeftMs: glance.driveLeftMs, windowLeftMs: glance.windowLeftMs, breakDueInMs: glance.breakDueInMs, cycleLeftMs: glance.cycleLeftMs };
          segments = segmentsFromLogs(snapshot.rows, now);
        } else {
          clocks = { driveLeftMs: 11 * 60 * 60_000, windowLeftMs: 14 * 60 * 60_000, breakDueInMs: 8 * 60 * 60_000, cycleLeftMs: null };
          assumedFull = true;
        }

        // The active load's appointments, from his records. A stop's
        // appointment fills the arrive-by on the event that IS that
        // stop, when the model didn't give one.
        const windows: PlanWindows = {};
        let loadLabel: string | null = null;
        try {
          const { data: loadsData, error: loadsError } = await client
            .from("loads")
            .select("*")
            .eq("company_id", companyId)
            .eq("status", "confirmed")
            .is("deleted_at", null)
            .limit(200);
          if (!loadsError) {
            const loads = (loadsData ?? []) as Load[];
            let load: Load | null = null;
            if (typeof args.load_id === "string") {
              load = loads.find((l) => l.id === args.load_id) ?? null;
              if (!load) return "That load isn't in his records.";
            } else {
              load = pickActiveLoad(loads, todayEastern())?.load ?? null;
            }
            if (load) {
              loadLabel = `${load.origin} → ${load.destination}`;
              const { data: stopsData } = await client
                .from("load_stops")
                .select("*")
                .eq("company_id", companyId)
                .eq("load_id", load.id)
                .is("deleted_at", null)
                .order("seq", { ascending: true });
              const stops = ((stopsData ?? []) as LoadStop[]).filter((s) => !s.deleted_at);
              const appt = (kind: "pickup" | "delivery") => {
                const s = stops.find((x) => x.kind === kind);
                const ms = s?.appointment_at ? Date.parse(s.appointment_at) : NaN;
                return Number.isFinite(ms) ? ms : null;
              };
              const pickupAppt = appt("pickup");
              const deliveryAppt = appt("delivery");
              if (pickupAppt !== null) windows.pickup = { startMs: pickupAppt, endMs: pickupAppt };
              if (deliveryAppt !== null) windows.delivery = { startMs: deliveryAppt, endMs: deliveryAppt };
              for (const ev of events) {
                if (ev.loadStop === "pickup" && ev.arriveByMs == null && pickupAppt !== null) ev.arriveByMs = pickupAppt;
                if (ev.loadStop === "delivery" && ev.arriveByMs == null && deliveryAppt !== null) ev.arriveByMs = deliveryAppt;
              }
            }
          }
        } catch {
          // Windows stay empty; the verdict says the load wasn't on file.
        }

        const evaluation = evaluatePlan({ events, clocks, segments, windows, nowMs: now, assumedFullClocks: assumedFull });
        const verdict = formatPlanVerdict(evaluation, now);
        return loadLabel
          ? `${verdict}\nLoad on file: ${loadLabel}.`
          : `${verdict}\nNo active load on file, so no pickup or delivery appointment was checked — the hours part is still real.`;
      },
    },
    {
      name: "quick_reference",
      description: `General, reviewed guidance for situations every driver hits: ${REFERENCE_TOPICS.join(", ")}. Use for 'what do I do if I break down / have an accident / get inspected / lose my BOL / sit at a dock', 'how do the hours rules work', 'what can I deduct', 'my settlement looks short'. It is fixed, careful text with NO dollar figures, fines or yearly tax numbers (those must come from his own stored values) and always ends with a not-advice note. Pass the topic or his own words.`,
      parameters: { type: "object", properties: { topic: { type: "string", description: "A topic name or his own words, e.g. 'flat tire'." } }, required: ["topic"] },
      access: "read",
      async run(args) {
        const key = findReference(String(args.topic ?? ""));
        if (!key) return `I don't have a reviewed checklist for that. I can cover: ${REFERENCE_TOPICS.map((t) => t.replace(/_/g, " ")).join(", ")}. For anything else I should say so plainly rather than guess.`;
        return formatReference(key);
      },
    },
  ];
}
