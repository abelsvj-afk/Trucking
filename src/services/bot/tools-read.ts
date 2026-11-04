// Agent omnipresence (docs/design/driver-mvp.md §9). The read
// tools that complete the bot's coverage of the app: §8 shipped
// loads/HOS/money-totals/contacts/documents/memories/dispatch -
// this file adds line-item expenses and fuel, duty-log entries,
// fleet detail (trucks incl. profile, trailers, drivers),
// inspections, checklist items, maintenance events + schedules,
// document CONTENT (extracted text, graceful absence until the
// scan branch's column lands), and BOTH briefing engines - the
// industry-intelligence engine's briefings and (R-6, Research
// Intelligence design D-7) the Deep Research engine's briefings
// plus its pending pre-trip photo requests. The two engines are
// labeled distinctly in every result: they are different products
// until the R-7 door merge, and an answer must never blur them.
//
// Every result is grounding text built from the actual query -
// the loop's grounding guard holds replies to figures that appear
// here, in the context, or in the owner's own message.

import { computeDueStatus } from "@/lib/maintenance-schedule";
import type { AgentTool } from "@/services/ai/agent-loop";
import {
  listPendingResearchRequests,
  requestPhotoItems,
  requestReason,
} from "@/services/research/requests";
import type { BotBrainStore } from "./store";
import { dollars, isMissingColumnError } from "./tool-helpers";
import type { MaintenanceSchedule } from "@/types/entities";

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

const DOCUMENT_BASE_COLUMNS = "id, file_name, related_entity_type, related_entity_id, uploaded_at, created_at";
const TRUCK_PROFILE_COLUMNS =
  "height_in, length_in, weight_lbs, governed_speed_mph, tank_capacity_gallons, avg_mpg, appliances, appliance_notes";

export function buildExtendedReadTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;

  async function vehicleLabels(): Promise<Map<string, string>> {
    const [trucks, trailers] = await Promise.all([
      client.from("trucks").select("id, unit_number").eq("company_id", companyId).is("deleted_at", null),
      client.from("trailers").select("id, unit_number").eq("company_id", companyId).is("deleted_at", null),
    ]);
    const labels = new Map<string, string>();
    for (const row of (trucks.data ?? []) as Row[]) labels.set(String(row.id), `truck ${row.unit_number}`);
    for (const row of (trailers.data ?? []) as Row[]) labels.set(String(row.id), `trailer ${row.unit_number}`);
    return labels;
  }

  function vehicleText(row: Row, labels: Map<string, string>): string {
    const id = str(row.truck_id) ?? str(row.trailer_id);
    return id ? (labels.get(id) ?? "a vehicle") : "no vehicle";
  }

  const tools: AgentTool[] = [
    {
      name: "list_expenses",
      description:
        "List individual expense line items (most recent first) over the last N days (default 30). Optionally filter by category or by load_id. Use for 'what did I spend on repairs' style questions that need the actual items, not just totals (money_summary gives totals).",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Lookback window in days, 1-90. Default 30." },
          category: { type: "string", enum: ["insurance", "permits", "repairs", "other"] },
          load_id: { type: "string" },
        },
      },
      access: "read",
      async run(args) {
        const days = Math.min(90, Math.max(1, typeof args.days === "number" ? args.days : 30));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        let query = client
          .from("expenses")
          .select("id, category, amount_cents, expense_date, description, load_id")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .gte("expense_date", since)
          .order("expense_date", { ascending: false })
          .limit(25);
        if (typeof args.category === "string") query = query.eq("category", args.category);
        if (typeof args.load_id === "string") query = query.eq("load_id", args.load_id);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0) return `No expenses on file in the last ${days} days matching that.`;
        return rows
          .map(
            (r) =>
              `- [${r.id}] ${r.expense_date} ${r.category}: ${dollars(num(r.amount_cents) ?? 0)}` +
              `${str(r.description) ? ` — ${r.description}` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "list_fuel_purchases",
      description: "List individual fuel purchases (most recent first) over the last N days (default 30): station/location, gallons, total paid, and which truck.",
      parameters: {
        type: "object",
        properties: { days: { type: "number", description: "Lookback window in days, 1-90. Default 30." } },
      },
      access: "read",
      async run(args) {
        const days = Math.min(90, Math.max(1, typeof args.days === "number" ? args.days : 30));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const [{ data, error }, labels] = await Promise.all([
          client
            .from("fuel_purchases")
            .select("id, truck_id, location, gallons, total_cost_cents, purchased_at")
            .eq("company_id", companyId)
            .is("deleted_at", null)
            .gte("purchased_at", since)
            .order("purchased_at", { ascending: false })
            .limit(25),
          vehicleLabels(),
        ]);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0) return `No fuel purchases on file in the last ${days} days.`;
        return rows
          .map(
            (r) =>
              `- [${r.id}] ${String(r.purchased_at).slice(0, 10)} ${dollars(num(r.total_cost_cents) ?? 0)} for ${r.gallons} gal` +
              `${str(r.location) ? ` at ${r.location}` : ""} (${labels.get(String(r.truck_id)) ?? "truck"})`,
          )
          .join("\n");
      },
    },
    {
      name: "list_duty_logs",
      description:
        "List his recent duty-log entries from the paper-log helper (most recent first): status, when it started, location, notes. For the computed clocks (11/14/70/30-min) use hos_summary instead.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "How many entries, 1-30. Default 15." } },
      },
      access: "read",
      async run(args) {
        const limit = Math.min(30, Math.max(1, typeof args.limit === "number" ? args.limit : 15));
        const { data, error } = await client
          .from("duty_logs")
          .select("id, duty_status, started_at, location, notes")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("started_at", { ascending: false })
          .limit(limit);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0) return "No duty logs on file yet.";
        return rows
          .map(
            (r) =>
              `- [${r.id}] ${r.duty_status} from ${r.started_at}` +
              `${str(r.location) ? ` in ${r.location}` : ""}${str(r.notes) ? ` — ${r.notes}` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "list_trucks",
      description: "List his trucks: unit number, make/model/year, status, current mileage, and id (needed by update tools).",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const { data, error } = await client
          .from("trucks")
          .select("id, unit_number, make, model, year, status, current_mileage")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("unit_number", { ascending: true });
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0) return "No trucks on file yet.";
        return rows
          .map(
            (r) =>
              `- [${r.id}] Truck ${r.unit_number}: ${[r.year, r.make, r.model].filter(Boolean).join(" ") || "details not captured"} (${r.status}` +
              `${num(r.current_mileage) != null ? `, ${r.current_mileage} mi` : ""})`,
          )
          .join("\n");
      },
    },
    {
      name: "get_truck",
      description:
        "One truck in full, including its Smart Path profile (height/length/weight, governed speed, tank, MPG, and the appliance inventory - what he can cook with). Give truck_id (from list_trucks) or unit_number.",
      parameters: {
        type: "object",
        properties: {
          truck_id: { type: "string" },
          unit_number: { type: "string" },
        },
      },
      access: "read",
      async run(args) {
        const baseColumns = "id, unit_number, vin, make, model, year, status, current_mileage";
        let query = client.from("trucks").select(`${baseColumns}, ${TRUCK_PROFILE_COLUMNS}`);
        query = query.eq("company_id", companyId).is("deleted_at", null);
        if (typeof args.truck_id === "string") query = query.eq("id", args.truck_id);
        else if (typeof args.unit_number === "string") query = query.eq("unit_number", args.unit_number);
        else return "Give me a truck id or unit number to look up.";

        let profileAvailable = true;
        let result = await query.maybeSingle();
        if (result.error && isMissingColumnError(result.error)) {
          // Graceful absence (design §9): the profile columns arrive
          // with Smart Path's migration 00017, which this branch does
          // not carry yet.
          profileAvailable = false;
          let fallback = client.from("trucks").select(baseColumns);
          fallback = fallback.eq("company_id", companyId).is("deleted_at", null);
          if (typeof args.truck_id === "string") fallback = fallback.eq("id", args.truck_id);
          else fallback = fallback.eq("unit_number", String(args.unit_number));
          result = await fallback.maybeSingle();
        }
        if (result.error) throw new Error(result.error.message);
        if (!result.data) return "No truck matching that in his records.";
        const r = result.data as Row;
        const lines = [
          `Truck ${r.unit_number} [${r.id}]: ${[r.year, r.make, r.model].filter(Boolean).join(" ") || "details not captured"}, status ${r.status}` +
            `${num(r.current_mileage) != null ? `, ${r.current_mileage} mi` : ""}${str(r.vin) ? `, VIN on file` : ""}.`,
        ];
        if (!profileAvailable) {
          lines.push(
            "Truck profile (size, speed, tank, MPG, appliances): those fields arrive with the Smart Path update and aren't in the database yet, so no profile is captured.",
          );
          return lines.join("\n");
        }
        const appliances = Array.isArray(r.appliances) ? (r.appliances as string[]) : [];
        const profileBits: string[] = [];
        if (num(r.height_in) != null) profileBits.push(`height ${r.height_in} in`);
        if (num(r.length_in) != null) profileBits.push(`length ${r.length_in} in`);
        if (num(r.weight_lbs) != null) profileBits.push(`weight ${r.weight_lbs} lbs`);
        if (num(r.governed_speed_mph) != null) profileBits.push(`governed ${r.governed_speed_mph} mph`);
        if (num(r.tank_capacity_gallons) != null) profileBits.push(`tank ${r.tank_capacity_gallons} gal`);
        if (num(r.avg_mpg) != null) profileBits.push(`${r.avg_mpg} mpg`);
        lines.push(
          profileBits.length > 0
            ? `Profile: ${profileBits.join(", ")}.`
            : "Profile: no dimensions/speed/tank/MPG captured yet.",
        );
        lines.push(
          appliances.length > 0
            ? `Appliances in the truck: ${appliances.join(", ")}${str(r.appliance_notes) ? ` (${r.appliance_notes})` : ""}.`
            : "Appliances in the truck: none captured yet.",
        );
        return lines.join("\n");
      },
    },
    {
      name: "list_trailers",
      description: "List his trailers: unit number, type, status, and id.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const { data, error } = await client
          .from("trailers")
          .select("id, unit_number, trailer_type, status")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("unit_number", { ascending: true });
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0) return "No trailers on file yet.";
        return rows
          .map((r) => `- [${r.id}] Trailer ${r.unit_number}: ${str(r.trailer_type) ?? "type not captured"} (${r.status})`)
          .join("\n");
      },
    },
    {
      name: "list_drivers",
      description:
        "List his drivers with detail: status, assigned truck, and whether a CDL number is on file (the number itself is never quoted in chat). For a bare name count, list_contacts also works.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const [{ data, error }, labels] = await Promise.all([
          client
            .from("drivers")
            .select("id, name, cdl_number, assigned_truck_id, status")
            .eq("company_id", companyId)
            .is("deleted_at", null)
            .order("name", { ascending: true }),
          vehicleLabels(),
        ]);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0) return "No drivers on file yet.";
        return rows
          .map(
            (r) =>
              `- [${r.id}] ${r.name} (${r.status})` +
              `${str(r.assigned_truck_id) ? `, assigned to ${labels.get(String(r.assigned_truck_id)) ?? "a truck"}` : ", no truck assigned"}` +
              `, CDL on file: ${str(r.cdl_number) ? "yes" : "no"}`,
          )
          .join("\n");
      },
    },
    {
      name: "list_inspections",
      description: "List recent pre-trip inspections with their results: when, which vehicle, passed or failed, and any defects found.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "How many, 1-30. Default 15." } },
      },
      access: "read",
      async run(args) {
        const limit = Math.min(30, Math.max(1, typeof args.limit === "number" ? args.limit : 15));
        const [{ data, error }, labels] = await Promise.all([
          client
            .from("pretrip_inspections")
            .select("id, truck_id, trailer_id, inspected_at, passed, defects_found")
            .eq("company_id", companyId)
            .is("deleted_at", null)
            .order("inspected_at", { ascending: false })
            .limit(limit),
          vehicleLabels(),
        ]);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0) return "No pre-trip inspections on file yet.";
        return rows
          .map(
            (r) =>
              `- [${r.id}] ${String(r.inspected_at).slice(0, 16).replace("T", " ")} ${vehicleText(r, labels)}: ${r.passed ? "PASSED" : "FAILED"}` +
              `${str(r.defects_found) ? ` — defects: ${r.defects_found}` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "list_checklist_items",
      description: "List his equipment checklist items (spares/tools that should be on board): item, quantity on hand, when last checked, and which vehicle they belong to.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const [{ data, error }, labels] = await Promise.all([
          client
            .from("equipment_checklist_items")
            .select("id, truck_id, trailer_id, item_name, quantity_on_hand, last_checked_date, notes")
            .eq("company_id", companyId)
            .is("deleted_at", null)
            .order("item_name", { ascending: true }),
          vehicleLabels(),
        ]);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0) return "No equipment checklist items on file yet.";
        return rows
          .map(
            (r) =>
              `- [${r.id}] ${r.item_name} (${vehicleText(r, labels)})` +
              `${num(r.quantity_on_hand) != null ? `, qty ${r.quantity_on_hand}` : ""}` +
              `${str(r.last_checked_date) ? `, last checked ${r.last_checked_date}` : ", never checked"}` +
              `${str(r.notes) ? ` — ${r.notes}` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "list_maintenance_events",
      description: "List maintenance/repair work already done (most recent first): what was done, when, what it cost, mileage, and which truck.",
      parameters: {
        type: "object",
        properties: { days: { type: "number", description: "Lookback window in days, 1-365. Default 90." } },
      },
      access: "read",
      async run(args) {
        const days = Math.min(365, Math.max(1, typeof args.days === "number" ? args.days : 90));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const [{ data, error }, labels] = await Promise.all([
          client
            .from("maintenance_events")
            .select("id, truck_id, description, cost_cents, service_date, mileage_at_service")
            .eq("company_id", companyId)
            .is("deleted_at", null)
            .gte("service_date", since)
            .order("service_date", { ascending: false })
            .limit(25),
          vehicleLabels(),
        ]);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0) return `No maintenance events on file in the last ${days} days.`;
        return rows
          .map(
            (r) =>
              `- [${r.id}] ${r.service_date} ${r.description} (${labels.get(String(r.truck_id)) ?? "truck"})` +
              `${num(r.cost_cents) != null ? `: ${dollars(num(r.cost_cents) ?? 0)}` : ""}` +
              `${num(r.mileage_at_service) != null ? ` at ${r.mileage_at_service} mi` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "list_maintenance_schedules",
      description:
        "List his preventative-maintenance schedules with computed due status (ok / due-soon / overdue / paused): what, which vehicle, the interval, when last done, and when it's next due.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const [{ data, error }, labels, trucksResult] = await Promise.all([
          client
            .from("maintenance_schedules")
            .select("*")
            .eq("company_id", companyId)
            .is("deleted_at", null)
            .order("description", { ascending: true }),
          vehicleLabels(),
          client
            .from("trucks")
            .select("id, current_mileage")
            .eq("company_id", companyId)
            .is("deleted_at", null),
        ]);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as unknown as MaintenanceSchedule[];
        if (rows.length === 0) return "No maintenance schedules on file yet.";
        const mileageByTruck = new Map(
          ((trucksResult.data ?? []) as Row[]).map((t) => [String(t.id), num(t.current_mileage)]),
        );
        return rows
          .map((r) => {
            const due = computeDueStatus(r, r.truck_id ? (mileageByTruck.get(r.truck_id) ?? null) : null);
            const row = r as unknown as Row;
            const interval =
              [
                num(row.interval_miles) != null ? `every ${row.interval_miles} mi` : null,
                num(row.interval_days) != null ? `every ${row.interval_days} days` : null,
              ]
                .filter(Boolean)
                .join(" / ") || "no interval";
            return (
              `- [${r.id}] ${r.description} (${vehicleText(row, labels)}): ${interval}` +
              `${r.last_done_date ? `, last done ${r.last_done_date}` : ", never done"}` +
              ` — due status: ${due.status.toUpperCase()}` +
              `${due.nextDueDate ? ` (next due ${due.nextDueDate})` : ""}${due.nextDueMileage != null ? ` (at ${due.nextDueMileage} mi)` : ""}`
            );
          })
          .join("\n");
      },
    },
    {
      name: "get_document",
      description:
        "Read one document in full: what it is, what it's attached to, and its extracted text content when the document has been scanned/extracted (BOLs, rate cons, paperwork). Get the document id from list_documents or search_documents. Use this whenever he asks what a document actually says.",
      parameters: {
        type: "object",
        properties: { document_id: { type: "string" } },
        required: ["document_id"],
      },
      access: "read",
      async run(args) {
        const id = String(args.document_id ?? "");
        let withText = await client
          .from("documents")
          .select(`${DOCUMENT_BASE_COLUMNS}, extracted_text`)
          .eq("id", id)
          .eq("company_id", companyId)
          .maybeSingle();
        let textAvailable = true;
        if (withText.error && isMissingColumnError(withText.error)) {
          // Graceful absence (design §9): the extracted_text column
          // arrives with the document-scan work; until then the tool
          // answers from metadata and says so.
          textAvailable = false;
          withText = await client
            .from("documents")
            .select(DOCUMENT_BASE_COLUMNS)
            .eq("id", id)
            .eq("company_id", companyId)
            .maybeSingle();
        }
        if (withText.error) throw new Error(withText.error.message);
        if (!withText.data) return `No document with id ${id} in his records.`;
        const r = withText.data as Row;
        const lines = [
          `Document [${r.id}]: ${r.file_name} (attached to ${r.related_entity_type} ${r.related_entity_id}, added ${String(r.uploaded_at).slice(0, 10)}).`,
        ];
        const text = str(r.extracted_text);
        if (!textAvailable) {
          lines.push("Extracted text: not available yet - document text extraction hasn't landed in the database, so I can only see the file's metadata, not its content.");
        } else if (text) {
          lines.push(`Extracted text:\n${text.slice(0, 4000)}${text.length > 4000 ? "\n[truncated]" : ""}`);
        } else {
          lines.push("Extracted text: this document hasn't been text-extracted yet, so I can only see its metadata, not its content.");
        }
        return lines.join("\n");
      },
    },
    {
      name: "search_documents",
      description:
        "Search his documents by file name AND by their extracted text content (when extraction exists) - e.g. a pickup number, a company name, 'detention'. Returns matching documents with ids for get_document.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      access: "read",
      async run(args) {
        const query = String(args.query ?? "").trim();
        if (!query) return "Give me a word or phrase to search his documents for.";
        const byName = await client
          .from("documents")
          .select(DOCUMENT_BASE_COLUMNS)
          .eq("company_id", companyId)
          .ilike("file_name", `%${query}%`)
          .order("created_at", { ascending: false })
          .limit(10);
        if (byName.error) throw new Error(byName.error.message);
        const merged = new Map<string, Row>();
        for (const row of (byName.data ?? []) as Row[]) merged.set(String(row.id), row);

        let contentNote: string | null = null;
        const byContent = await client
          .from("documents")
          .select(`${DOCUMENT_BASE_COLUMNS}, extracted_text`)
          .eq("company_id", companyId)
          .ilike("extracted_text", `%${query}%`)
          .order("created_at", { ascending: false })
          .limit(10);
        if (byContent.error) {
          if (!isMissingColumnError(byContent.error)) throw new Error(byContent.error.message);
          contentNote = "Document content search isn't available yet (text extraction hasn't landed) - matched file names only.";
        } else {
          for (const row of (byContent.data ?? []) as Row[]) merged.set(String(row.id), row);
        }

        // Lane 1 (audit B-6): captions stored on the row are
        // searchable too - same graceful absence as extracted text
        // before migration 00033 lands.
        const byCaption = await client
          .from("documents")
          .select(DOCUMENT_BASE_COLUMNS)
          .eq("company_id", companyId)
          .ilike("caption", `%${query}%`)
          .order("created_at", { ascending: false })
          .limit(10);
        if (!byCaption.error) {
          for (const row of (byCaption.data ?? []) as Row[]) merged.set(String(row.id), row);
        } else if (!isMissingColumnError(byCaption.error)) {
          throw new Error(byCaption.error.message);
        }

        const rows = [...merged.values()];
        if (rows.length === 0) {
          return `No documents match "${query}".${contentNote ? ` ${contentNote}` : ""}`;
        }
        const lines = rows.map(
          (r) => `- [${r.id}] ${r.file_name} (attached to ${r.related_entity_type}, added ${String(r.uploaded_at).slice(0, 10)})`,
        );
        if (contentNote) lines.push(contentNote);
        return lines.join("\n");
      },
    },
    {
      name: "list_industry_briefings",
      description:
        "List recent briefings from the INDUSTRY-INTELLIGENCE engine (the older daily-summary engine - NOT Deep Research): summary, confidence, when generated. One of his two briefing engines; name it as the industry-intelligence engine when you report from it.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "How many, 1-10. Default 5." } },
      },
      access: "read",
      async run(args) {
        const limit = Math.min(10, Math.max(1, typeof args.limit === "number" ? args.limit : 5));
        const { data, error } = await client
          .from("industry_briefings")
          .select("id, summary, confidence, generated_at")
          .eq("company_id", companyId)
          .is("dismissed_at", null)
          .order("generated_at", { ascending: false })
          .limit(limit);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0)
          return "From the industry-intelligence engine: no briefings on file yet.";
        return [
          "From the industry-intelligence engine (daily summaries - not Deep Research):",
          ...rows.map(
            (r) => `- [${r.id}] (${String(r.generated_at).slice(0, 10)}, confidence ${r.confidence}) ${r.summary}`,
          ),
        ].join("\n");
      },
    },
    {
      name: "list_research_briefings",
      description:
        "List recent briefings from the DEEP RESEARCH engine (the pressure-triggered research engine - NOT the industry-intelligence engine): title, headline, takeaway, counter-move, topic, confidence. Use when he asks what the research found, and check BOTH engines before answering - label which engine each briefing came from.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "How many, 1-10. Default 5." } },
      },
      access: "read",
      async run(args) {
        const limit = Math.min(10, Math.max(1, typeof args.limit === "number" ? args.limit : 5));
        const { data, error } = await client
          .from("research_briefings")
          .select("id, topic, title, headline, takeaway, counter_move, confidence, created_at")
          .eq("company_id", companyId)
          .is("dismissed_at", null)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Row[];
        if (rows.length === 0)
          return "From the Deep Research engine: no briefings on file yet.";
        return [
          "From the Deep Research engine (full research reports - not the industry-intelligence summaries):",
          ...rows.map(
            (r) =>
              `- [${r.id}] (${String(r.created_at).slice(0, 10)}, ${r.topic}, confidence ${r.confidence}) ${r.title}\n  ${r.headline}\n  Takeaway: ${r.takeaway}\n  Counter-move: ${r.counter_move}`,
          ),
        ].join("\n");
      },
    },
    {
      name: "get_research_briefing",
      description:
        "Read one Deep Research briefing in full (from list_research_briefings' ids): findings with their sources, what changed, counter-move, takeaway, and anything the engine flagged as unverified. Use when he wants the detail behind a Deep Research headline.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The briefing id from list_research_briefings." } },
        required: ["id"],
      },
      access: "read",
      async run(args) {
        const id = String(args.id ?? "").trim();
        if (!id) return "Give me the briefing id from list_research_briefings.";
        const { data, error } = await client
          .from("research_briefings")
          .select(
            "id, topic, title, headline, findings, what_changed, counter_move, takeaway, unverified, sources, confidence, created_at",
          )
          .eq("company_id", companyId)
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) return `No Deep Research briefing with id ${id} on file.`;
        const r = data as Row;
        const lines = [
          `Deep Research briefing [${r.id}] - ${r.title}`,
          `Topic: ${r.topic} · confidence ${r.confidence} · ${String(r.created_at).slice(0, 10)}`,
          String(r.headline),
          "Findings:",
        ];
        const findings = Array.isArray(r.findings) ? (r.findings as Row[]) : [];
        if (findings.length === 0) lines.push("- (none recorded)");
        for (const f of findings) {
          lines.push(`- ${f.claim} (${f.source_title}: ${f.source_url})`);
        }
        lines.push(`What changed: ${r.what_changed}`);
        lines.push(`Counter-move: ${r.counter_move}`);
        lines.push(`Takeaway: ${r.takeaway}`);
        const unverified = Array.isArray(r.unverified) ? (r.unverified as unknown[]) : [];
        if (unverified.length > 0) {
          lines.push(
            `Flagged unverified by the engine: ${unverified.map((u) => (typeof u === "string" ? u : JSON.stringify(u))).join("; ")}`,
          );
        }
        return lines.join("\n");
      },
    },
    {
      name: "list_research_requests",
      description:
        "List the Deep Research engine's pending pre-trip photo asks (research_requests still waiting on him): what to photograph, why, and the load they're for when there is one. Use when he asks what photos are wanted, or before a pre-trip when an ask may be outstanding.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const pending = await listPendingResearchRequests(client, companyId);
        if (pending.length === 0) return "No pre-trip photo asks are waiting on him.";
        const lines = ["Pending pre-trip photo asks from the Deep Research engine:"];
        for (const request of pending) {
          const items = requestPhotoItems(request).join(", ");
          const reason = requestReason(request);
          lines.push(
            `- [${request.id}] photograph: ${items}${request.load_id ? ` (load ${request.load_id})` : ""}${reason ? ` - why: ${reason}` : ""}`,
          );
        }
        return lines.join("\n");
      },
    },
  ];

  return tools;
}
