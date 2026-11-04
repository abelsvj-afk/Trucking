// Event → schedule pairing (Image Intelligence design §5.4):
// recording maintenance used to leave its schedule untouched -
// the "next due" never moved and the reminder kept firing for
// work already done. Now, when a create_maintenance_event
// proposal is staged, code finds the schedule it belongs to and
// pairs a completion proposal INTO THE SAME BATCH: one yes
// records the work AND advances the schedule, and a partial yes
// can take either without the other (acceptance C1).
//
// The match, in order: the event's template_key when the agent
// supplied one; else a keyword guess from the work description,
// labeled a guess in the item's source quote. No match → no
// pairing, never a stretch. The completion's done_mileage is the
// event's mileage_at_service when given, else the schedule tool
// falls back to the truck's current mileage at execution.

import { randomUUID } from "node:crypto";
import type { ProposedWrite } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { buildBotTools } from "./tools";
import { guessTemplateKey, templateByKey } from "@/lib/maintenance-templates";

interface ScheduleRow {
  id: string;
  description: string;
  template_key: string | null;
  last_done_date: string | null;
}

export async function expandMaintenancePairings(
  store: BotBrainStore,
  proposals: ProposedWrite[],
): Promise<ProposedWrite[]> {
  const eventIndexes = proposals
    .map((p, i) => (p.tool === "create_maintenance_event" ? i : -1))
    .filter((i) => i >= 0);
  if (eventIndexes.length === 0) return proposals;

  const completionTool = buildBotTools(store).find((t) => t.name === "complete_maintenance_schedule");
  if (!completionTool?.validateArgs || !completionTool.summarize) return proposals;

  const alreadyCompleted = new Set(
    proposals
      .filter((p) => p.tool === "complete_maintenance_schedule")
      .map((p) => String(p.args.schedule_id ?? "")),
  );

  const expanded = [...proposals];
  // Insert companions from the end so earlier indexes stay valid.
  for (const index of [...eventIndexes].reverse()) {
    const event = expanded[index]!;
    const truckId = typeof event.args.truck_id === "string" ? event.args.truck_id : null;
    const description = typeof event.args.description === "string" ? event.args.description : "";
    if (!truckId) continue;

    const suppliedKey = typeof event.args.template_key === "string" ? event.args.template_key : null;
    const guessed = suppliedKey ? null : guessTemplateKey(description);
    const key = suppliedKey ?? guessed;
    if (!key) continue;

    const { data, error } = await store.client
      .from("maintenance_schedules")
      .select("id, description, template_key, last_done_date")
      .eq("company_id", store.companyId)
      .eq("truck_id", truckId)
      .eq("template_key", key)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) {
      // Pre-00046 there is no template_key column - pairing is
      // simply unavailable; the event proposal stands on its own.
      if (/does not exist/i.test(error.message)) return proposals;
      throw new Error(error.message);
    }
    const schedule = ((data ?? []) as ScheduleRow[])[0];
    if (!schedule || alreadyCompleted.has(schedule.id)) continue;

    const args: Record<string, unknown> = { schedule_id: schedule.id };
    if (typeof event.args.service_date === "string") args.done_date = event.args.service_date;
    if (typeof event.args.mileage_at_service === "number") {
      args.done_mileage = event.args.mileage_at_service;
    }
    const validation = completionTool.validateArgs(args);
    if (!validation.ok) continue;

    const batchId = event.batchId ?? randomUUID();
    expanded[index] = { ...event, batchId };
    const template = templateByKey(key);
    expanded.splice(index + 1, 0, {
      tool: "complete_maintenance_schedule",
      args: validation.args,
      summary: completionTool.summarize(validation.args),
      batchId,
      sourceQuote: guessed
        ? `paired with the "${schedule.description}" schedule - the pairing is a guess from the work description (${template?.label ?? key}); drop this item if it's wrong`
        : `paired with the "${schedule.description}" schedule`,
      confidence: guessed ? "medium" : "high",
    });
    alreadyCompleted.add(schedule.id);
  }
  return expanded;
}
