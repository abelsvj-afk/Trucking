// Tools for the questions every kind of driver asks (owner 2026-11-07;
// docs/design/fleet-learning-and-driver-questions.md section 6): "is this rate good", "can I make the appointment",
// "what do I do if...". All READ tools; numbers are computed in code, the guidance is fixed reviewed text.

import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { todayEastern } from "@/lib/eastern-date";
import { resolveWhen } from "@/lib/temporal";
import { formatLaneStats, laneStats, type LaneLoad } from "@/lib/lane-stats";
import { DEFAULT_MPH, describeTripPlan, easternToEpoch, parseClock, planTrip, type Clocks } from "@/lib/trip-plan";
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
