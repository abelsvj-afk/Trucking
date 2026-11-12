// Abel's fleet tools (owner 2026-11-07; docs/design/fleet-learning-and-driver-questions.md section 3): learn each driver,
// recommend loads that balance money against comfort, know when a driver is due home, and see the fleet at a glance.
// Reads are computed in code from his records; the ONE write, record_preference, is always a proposal he approves -
// a preference becomes stored fact only after his yes, whether he stated it or Abel learned it from his decisions.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { validateWith } from "./tool-helpers";
import { todayEastern } from "@/lib/eastern-date";
import { formatLong } from "@/lib/temporal";
import { weekBounds } from "@/lib/pay-projection";
import { describePreference, parsePreference, prefValue, type PrefRow } from "@/lib/fleet/preferences";
import { learnFromDecisions, MIN_N, type DecisionFeatures } from "@/lib/fleet/learn-decisions";
import { formatRanking, rankCandidates, type CandidateLoad, type DriverProfile } from "@/lib/fleet/recommend";
import { formatHomeTime, homeTimeStatus } from "@/lib/fleet/home-time";
import { laneAverager, laneStats, stateOf, type LaneLoad } from "@/lib/lane-stats";
import { normalizeState } from "@/lib/fleet/regions";
import { loadPayCalendarTerms } from "./pay-phrases";
import { formatMoney } from "@/lib/money-format";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usd = (cents: number) => formatMoney(cents);

const recordPreferenceArgs = z
  .object({
    subject: z.enum(["driver", "owner"]).default("driver"),
    driver: z.string().min(1).optional(),
    key: z.string().min(1),
    value: z.unknown(),
    source: z.enum(["stated", "learned"]).default("stated"),
    evidence: z.string().min(1).max(300).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((a) => a.subject === "owner" || Boolean(a.driver), { message: "name the driver this preference is about", path: ["driver"] })
  .refine((a) => a.source !== "learned" || Boolean(a.evidence), { message: "a learned preference must carry its evidence in plain words", path: ["evidence"] })
  .refine((a) => a.value !== undefined, { message: "a value is required", path: ["value"] });

export function buildFleetTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;

  /** A driver by uuid or by name; says so plainly when there is none or when the name fits several. */
  async function findDriver(text: string): Promise<{ driver: { id: string; name: string } } | { error: string }> {
    const q = text.trim();
    let query = client.from("drivers").select("id, name, status").eq("company_id", companyId).is("deleted_at", null);
    query = UUID.test(q) ? query.eq("id", q) : query.ilike("name", `%${q}%`);
    const { data, error } = await query.limit(10);
    if (error) return { error: `couldn't look up drivers (${error.message})` };
    const rows = (data ?? []) as { id: string; name: string }[];
    if (rows.length === 0) return { error: `there is no driver matching "${q}" - use list_drivers to see who is on file` };
    if (rows.length > 1) return { error: `"${q}" fits more than one driver (${rows.map((r) => r.name).join(", ")}) - say which one` };
    return { driver: rows[0]! };
  }

  async function loadPrefs(subject: "owner" | "driver", driverId: string | null): Promise<PrefRow[]> {
    let query = client
      .from("person_preferences")
      .select("key, value, source, confidence, evidence")
      .eq("company_id", companyId)
      .eq("subject_type", subject)
      .is("deleted_at", null);
    query = driverId ? query.eq("driver_id", driverId) : query.is("driver_id", null);
    const { data, error } = await query;
    if (error) return []; // migration 00077 not applied yet: no preferences are known, nothing breaks
    return ((data ?? []) as PrefRow[]).map((r) => ({ ...r, confidence: Number(r.confidence) }));
  }

  const profileOf = (rows: PrefRow[]): DriverProfile => ({
    homeState: prefValue<{ state: string }>(rows, "home_base")?.state ?? null,
    preferredRegions: prefValue<string[]>(rows, "preferred_regions") ?? [],
    avoidRegions: prefValue<string[]>(rows, "avoid_regions") ?? [],
    minTripMiles: prefValue<number>(rows, "min_trip_miles") ?? null,
    maxTripMiles: prefValue<number>(rows, "max_trip_miles") ?? null,
    minCentsPerMile: prefValue<number>(rows, "min_cents_per_mile") ?? null,
  });

  async function bookedLoads(driverId: string) {
    const { data } = await client
      .from("loads")
      .select("origin, destination, destination_state, pickup_date, delivery_date, status")
      .eq("company_id", companyId)
      .eq("driver_id", driverId)
      .eq("status", "confirmed")
      .is("deleted_at", null)
      .limit(50);
    return ((data ?? []) as Row[]).map((l) => ({
      origin: String(l.origin), destination: String(l.destination), destination_state: (l.destination_state as string | null) ?? stateOf(String(l.destination)),
      pickup_date: (l.pickup_date as string | null) ?? null, delivery_date: (l.delivery_date as string | null) ?? null,
    }));
  }

  async function homeStatusFor(driverId: string, name: string, rows: PrefRow[], today: string) {
    const rhythm = prefValue<{ every_days: number; min_days: number }>(rows, "home_time");
    const status = homeTimeStatus({
      today,
      lastHomeDate: prefValue<string>(rows, "last_home_date") ?? null,
      everyDays: rhythm?.every_days ?? null,
      minDays: rhythm?.min_days ?? null,
      homeState: prefValue<{ state: string }>(rows, "home_base")?.state ?? null,
      booked: await bookedLoads(driverId),
    });
    return { status, text: formatHomeTime(name, status, rhythm?.min_days ?? null) };
  }

  async function priced(): Promise<LaneLoad[]> {
    const { data } = await client
      .from("loads")
      .select("origin, destination, origin_state, destination_state, rate_cents, miles, pickup_date, delivery_date")
      .eq("company_id", companyId)
      .in("status", ["confirmed", "completed"])
      .is("deleted_at", null)
      .limit(400);
    return (data ?? []) as LaneLoad[];
  }

  const driverArg = { driver: { type: "string", description: "The driver's name (or id) - use list_drivers if unsure." } };

  return [
    {
      name: "driver_profile",
      description:
        "Everything Abel knows about one driver: stored preferences (each marked stated by the owner or learned from decisions, with confidence and the evidence), where they are on home time, and their recent loads and pay-per-mile. Use for 'tell me about Steven', 'what does Dee like', before recommending loads, or when planning around a driver.",
      parameters: { type: "object", properties: driverArg, required: ["driver"] },
      access: "read",
      async run(args) {
        const found = await findDriver(String(args.driver ?? ""));
        if ("error" in found) return found.error;
        const { id, name } = found.driver;
        const today = todayEastern();
        const rows = await loadPrefs("driver", id);
        const home = await homeStatusFor(id, name, rows, today);
        const lines = [`👤 ${name}`];
        if (rows.length === 0) lines.push("No preferences recorded yet - ask him (or the owner) and I will remember them.");
        for (const r of rows) {
          const tag = r.source === "stated" ? "stated" : `learned ${Math.round(r.confidence * 100)}% - ${r.evidence ?? "no evidence recorded"}`;
          lines.push(`  • ${describePreference(r.key, r.value)} (${tag})`);
        }
        lines.push("", home.text);
        const { data } = await client.from("loads").select("rate_cents, miles, status, delivery_date").eq("company_id", companyId).eq("driver_id", id).in("status", ["confirmed", "completed"]).is("deleted_at", null).limit(100);
        const mine = (data ?? []) as LaneLoad[];
        if (mine.length > 0) {
          const s = laneStats(mine, null, null);
          lines.push("", `🚚 ${mine.length} load${mine.length === 1 ? "" : "s"} on file${s.n ? `, averaging ${usd(s.avgCents!)}/mile over ${s.n} priced` : ""}.`);
        }
        lines.push("", "This is for planning and comfort - not a score or a ranking against other drivers.");
        return lines.join("\n");
      },
    },
    {
      name: "record_preference",
      description:
        "Remember a PREFERENCE - a driver's (subject 'driver': home_base {city,state}, home_time {every_days, min_days}, last_home_date YYYY-MM-DD, preferred_regions [..], avoid_regions [..], min_trip_miles, max_trip_miles, min_cents_per_mile, weekly_pay_target_cents, weekend_home, comfort_notes) or the owner's own (subject 'owner': weekly_revenue_target_cents, money_vs_comfort 0-1 where 0 is all comfort and 1 all money, news_interest:trucking|regulation|tech|politics|world as 0-1). source 'stated' when he or the driver said it; 'learned' ONLY for a pattern from learn_driver_patterns, with its evidence. Cents are integer cents ($1.90/mile = 190). Always a proposal for his yes.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", enum: ["driver", "owner"] },
          driver: { type: "string", description: "Which driver (name or id) - required for subject 'driver'." },
          key: { type: "string" },
          value: { description: "The value for that key (a number, text, true/false, an object or a list, as the key requires)." },
          source: { type: "string", enum: ["stated", "learned"] },
          evidence: { type: "string", description: "Required when learned: what the decisions show, in plain words." },
          confidence: { type: "number", description: "0-1; for learned preferences." },
        },
        required: ["key", "value"],
      },
      access: "write",
      alwaysPropose: true,
      validateArgs: validateWith(recordPreferenceArgs),
      summarize(args) {
        const a = recordPreferenceArgs.parse(args);
        return `Remember${a.subject === "driver" ? ` for ${a.driver}` : ""}: ${describePreference(a.key, a.value)} (${a.source})`;
      },
      async verifyProposal(args) {
        const a = recordPreferenceArgs.safeParse(args);
        if (!a.success) return { ok: false, error: a.error.issues[0]?.message ?? "invalid arguments" };
        const parsed = parsePreference(a.data.subject, a.data.key, a.data.value);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        let driverId: string | null = null;
        let name = "";
        if (a.data.subject === "driver") {
          const found = await findDriver(a.data.driver!);
          if ("error" in found) return { ok: false, error: found.error };
          driverId = found.driver.id;
          name = found.driver.name;
        }
        const existing = (await loadPrefs(a.data.subject, driverId)).find((r) => r.key === a.data.key);
        const change = existing ? `${describePreference(a.data.key, existing.value)} → ${describePreference(a.data.key, parsed.value)}` : describePreference(a.data.key, parsed.value);
        const how = a.data.source === "learned" ? `learned ${Math.round((a.data.confidence ?? 0.6) * 100)}% - ${a.data.evidence}` : "stated";
        return { ok: true, summary: `Remember${name ? ` for ${name}` : " for the owner"}: ${change} (${how})` };
      },
      async run(args) {
        const a = recordPreferenceArgs.parse(args);
        const parsed = parsePreference(a.subject, a.key, a.value);
        if (!parsed.ok) throw new Error(parsed.error);
        let driverId: string | null = null;
        if (a.subject === "driver") {
          const found = await findDriver(a.driver!);
          if ("error" in found) throw new Error(found.error);
          driverId = found.driver.id;
        }
        const fields = {
          value: parsed.value,
          source: a.source,
          confidence: a.source === "stated" ? 1 : (a.confidence ?? 0.6),
          evidence: a.evidence ?? null,
          updated_at: new Date().toISOString(),
        };
        let query = client.from("person_preferences").select("id").eq("company_id", companyId).eq("subject_type", a.subject).eq("key", a.key).is("deleted_at", null);
        query = driverId ? query.eq("driver_id", driverId) : query.is("driver_id", null);
        const { data: existing, error: readError } = await query.maybeSingle();
        if (readError) throw new Error(`couldn't save the preference (${readError.message}) - migration 00077 may not be applied yet`);
        const write = existing
          ? await client.from("person_preferences").update(fields).eq("id", (existing as { id: string }).id).eq("company_id", companyId)
          : await client.from("person_preferences").insert({ company_id: companyId, subject_type: a.subject, driver_id: driverId, key: a.key, ...fields });
        if (write.error) throw new Error(write.error.message);
        return `Remembered: ${describePreference(a.key, parsed.value)}.`;
      },
    },
    {
      name: "learn_driver_patterns",
      description:
        "What his logged load decisions (taken / passed, with their states, miles, pay and deadhead) say about a driver's preferences - candidate patterns WITH their evidence and confidence, nothing saved. Omit driver to look at all logged decisions. A pattern needs at least 4 decisions in a bucket and a clear lean before it shows. To keep one, propose it with record_preference (source 'learned', the evidence) - he must say yes. Say plainly when there is not enough history.",
      parameters: { type: "object", properties: { driver: { type: "string", description: "Optional: only this driver's decisions." } } },
      access: "read",
      async run(args) {
        let driverId: string | null = null;
        let name = "all logged decisions";
        if (typeof args.driver === "string" && args.driver.trim()) {
          const found = await findDriver(args.driver);
          if ("error" in found) return found.error;
          driverId = found.driver.id;
          name = found.driver.name;
        }
        let query = client.from("load_decisions").select("decision, origin_state, destination_state, miles, rate_cents, deadhead_miles").eq("company_id", companyId).is("deleted_at", null);
        if (driverId) query = query.eq("driver_id", driverId);
        const { data, error } = await query.order("created_at", { ascending: false }).limit(300);
        if (error) return "The decision log's structured fields aren't available yet (migration 00077 not applied), so there is nothing to learn from.";
        const decisions = (data ?? []) as DecisionFeatures[];
        const withFeatures = decisions.filter((d) => d.destination_state || d.miles || d.rate_cents).length;
        const stored = driverId ? await loadPrefs("driver", driverId) : [];
        const candidates = learnFromDecisions(decisions).filter((c) => JSON.stringify(prefValue(stored, c.key)) !== JSON.stringify(c.value));
        if (candidates.length === 0) {
          return `Nothing to learn yet from ${name}: ${decisions.length} logged decision${decisions.length === 1 ? "" : "s"}, ${withFeatures} with details (states, miles, pay). A pattern needs at least ${MIN_N} decisions in the same bucket (a region, a trip length, a rate range) and a clear lean. Keep logging decisions with record_load_decision - include the states, miles, pay and his reason.`;
        }
        return [
          `Patterns in ${name} (${decisions.length} decisions) - NOT saved:`,
          ...candidates.map((c) => `  • ${describePreference(c.key, c.value)} - ${Math.round(c.confidence * 100)}% sure: ${c.evidence}\n    to keep it: record_preference key "${c.key}", value ${JSON.stringify(c.value)}, source "learned", evidence "${c.evidence}", confidence ${c.confidence}`),
          "Propose each one to him; it becomes a preference only if he says yes.",
        ].join("\n");
      },
    },
    {
      name: "recommend_loads",
      description:
        "Compare candidate loads for a driver and rank them, with the reasons: money (rate per mile counting deadhead, against his own lane history and the driver's minimum), comfort (regions and trip length he prefers or avoids) and home time (does it fit when he is due home), weighted by the owner's money-vs-comfort dial. Give the offers in `loads` (state, miles, pay) and/or set include_draft_loads to rank the draft loads already in the app. A load that conflicts with a preference is shown as a CONFLICT with the reason, never hidden. Recommendation only - nothing is booked.",
      parameters: {
        type: "object",
        properties: {
          ...driverArg,
          loads: {
            type: "array",
            description: "Offers to compare.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "How to refer to it, e.g. 'Memphis load'." },
                origin_state: { type: "string" }, destination_state: { type: "string" },
                miles: { type: "number" }, rate_dollars: { type: "number" }, deadhead_miles: { type: "number" },
                pickup_date: { type: "string" }, delivery_date: { type: "string" },
              },
              required: ["label"],
            },
          },
          include_draft_loads: { type: "boolean", description: "Also rank the draft loads in the app." },
        },
        required: ["driver"],
      },
      access: "read",
      async run(args) {
        const found = await findDriver(String(args.driver ?? ""));
        if ("error" in found) return found.error;
        const { id, name } = found.driver;
        const today = todayEastern();
        const rows = await loadPrefs("driver", id);
        const owner = await loadPrefs("owner", null);
        const dial = prefValue<number>(owner, "money_vs_comfort") ?? 0.5;

        const candidates: CandidateLoad[] = [];
        for (const raw of Array.isArray(args.loads) ? (args.loads as Row[]) : []) {
          candidates.push({
            id: `offer-${candidates.length + 1}`,
            label: String(raw.label ?? `Offer ${candidates.length + 1}`),
            origin_state: normalizeState(raw.origin_state as string),
            destination_state: normalizeState(raw.destination_state as string),
            miles: typeof raw.miles === "number" ? raw.miles : null,
            rate_cents: typeof raw.rate_dollars === "number" ? Math.round(raw.rate_dollars * 100) : null,
            deadhead_miles: typeof raw.deadhead_miles === "number" ? raw.deadhead_miles : null,
            pickup_date: (raw.pickup_date as string) ?? null,
            delivery_date: (raw.delivery_date as string) ?? null,
          });
        }
        if (args.include_draft_loads === true) {
          const { data } = await client.from("loads").select("id, origin, destination, origin_state, destination_state, miles, rate_cents, deadhead_miles, pickup_date, delivery_date").eq("company_id", companyId).eq("status", "draft").is("deleted_at", null).limit(15);
          for (const l of (data ?? []) as Row[]) {
            candidates.push({
              id: String(l.id), label: `${l.origin} → ${l.destination}`,
              origin_state: normalizeState(l.origin_state as string) ?? stateOf(String(l.origin)), destination_state: normalizeState(l.destination_state as string) ?? stateOf(String(l.destination)),
              miles: (l.miles as number | null) ?? null, rate_cents: (l.rate_cents as number | null) ?? null, deadhead_miles: (l.deadhead_miles as number | null) ?? null,
              pickup_date: (l.pickup_date as string | null) ?? null, delivery_date: (l.delivery_date as string | null) ?? null,
            });
          }
        }
        if (candidates.length === 0) return "No loads to compare. Give me the offers (destination state, miles, pay, deadhead) or say to use the draft loads in the app.";

        const home = await homeStatusFor(id, name, rows, today);
        const history = await priced();
        const ranked = rankCandidates(candidates, profileOf(rows), { moneyVsComfort: dial, laneAvgCentsPerMile: laneAverager(history), homeDueInDays: home.status.daysUntilDue });
        const known = rows.length === 0 ? "\nNo preferences are recorded for him yet, so comfort and home time score neutral - tell me what he likes and avoids and these get sharper." : "";
        return `Loads for ${name}:\n${formatRanking(ranked, dial)}${known}\n${home.status.level === "unknown" ? "" : `\n${home.text}\n`}\nRecommendation only - nothing is booked; the owner and the driver decide.`;
      },
    },
    {
      name: "home_time_status",
      description:
        "Is a driver ready to go home? Days out (from the last-home date), when home time is due (from the agreed rhythm, e.g. every 14 days for 2), how urgent, which booked loads run past the due date, and which booked loads end at home - the windows where home time fits. Say plainly what is missing (no last-home date, no rhythm, no home base) instead of guessing.",
      parameters: { type: "object", properties: driverArg, required: ["driver"] },
      access: "read",
      async run(args) {
        const found = await findDriver(String(args.driver ?? ""));
        if ("error" in found) return found.error;
        const rows = await loadPrefs("driver", found.driver.id);
        return (await homeStatusFor(found.driver.id, found.driver.name, rows, todayEastern())).text;
      },
    },
    {
      name: "fleet_overview",
      description:
        "The whole fleet at a glance: each active driver's home-time status and current/next load, and this pay week's booked revenue against the owner's weekly target with what is still needed. Use for 'who needs home time', 'who is open', 'are we on track this week', 'how is the fleet doing'. Gross load revenue, not profit.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const today = todayEastern();
        const { data: drivers, error } = await client.from("drivers").select("id, name, status").eq("company_id", companyId).is("deleted_at", null).eq("status", "active").limit(60);
        if (error) throw new Error(error.message);
        const owner = await loadPrefs("owner", null);
        const target = prefValue<number>(owner, "weekly_revenue_target_cents");
        const terms = await loadPayCalendarTerms(client as never, companyId, today);
        const week = weekBounds(today, terms?.pay_week_ends_on);

        const { data: loads } = await client.from("loads").select("driver_id, origin, destination, status, rate_cents, pickup_date, delivery_date").eq("company_id", companyId).in("status", ["confirmed", "completed"]).is("deleted_at", null).limit(300);
        const all = (loads ?? []) as Row[];
        const inWeek = all.filter((l) => {
          const day = (l.delivery_date as string | null) ?? (l.pickup_date as string | null);
          return day && day >= week.start && day <= week.end;
        });
        const booked = inWeek.reduce((t, l) => t + (typeof l.rate_cents === "number" ? l.rate_cents : 0), 0);
        const unpriced = inWeek.filter((l) => typeof l.rate_cents !== "number").length;

        const lines: string[] = [`🚛 Fleet as of ${formatLong(today)}`, ""];
        const roster = (drivers ?? []) as { id: string; name: string }[];
        if (roster.length === 0) lines.push("No active drivers on file.");
        for (const d of roster) {
          const rows = await loadPrefs("driver", d.id);
          const h = await homeStatusFor(d.id, d.name, rows, today);
          const mine = all.filter((l) => l.driver_id === d.id && l.status === "confirmed").sort((a, b) => String(a.pickup_date ?? "9").localeCompare(String(b.pickup_date ?? "9")));
          const current = mine[0] ? `${mine[0].origin} → ${mine[0].destination}` : "no booked load";
          lines.push(h.text.split("\n")[0]!, `    🚚 ${current}`);
        }
        lines.push("", `💵 Pay week ${week.start} to ${week.end}: ${usd(booked)} of gross load revenue booked${unpriced ? ` (${unpriced} load${unpriced === 1 ? "" : "s"} have no rate yet)` : ""}.`);
        if (target) {
          const left = Math.max(0, target - booked);
          const daysLeft = Math.max(1, Math.round((Date.parse(`${week.end}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) + 1);
          lines.push(left === 0 ? `🎯 Target ${usd(target)}: reached.` : `🎯 Target ${usd(target)}: ${usd(left)} still needed over the ${daysLeft} day${daysLeft === 1 ? "" : "s"} left (about ${usd(Math.ceil(left / daysLeft))} a day).`);
        } else lines.push("🎯 No weekly revenue target set - tell me one and I will track the gap.");
        lines.push("", "Home time and loads are for planning around people - not a ranking of drivers.");
        return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
      },
    },
  ];
}
