// The one-yes maintenance pack (Image Intelligence design §5.2):
// when a truck has no tracked maintenance, Abel proposes the
// whole standard library for it in ONE batch - one yes sets up
// his maintenance tracking. The rows land with last_done EMPTY:
// their status computes "unknown", Abel asks once when each was
// last done, and nothing about the truck's history is invented
// to make the board look complete.
//
// Proposed ONCE per truck: a bookkeeping memory records the
// proposal, and a pack that was proposed (accepted, partly
// accepted, or rejected) is never auto-proposed again - he can
// always ask for it in words.

import { randomUUID } from "node:crypto";
import type { BotBrainStore } from "@/services/bot/store";
import { buildBotTools } from "@/services/bot/tools";
import { formatBatchProposal } from "@/services/bot/dump-intake";
import {
  MAINTENANCE_TEMPLATES,
  TEMPLATE_HONESTY_LABEL,
  type MaintenanceTemplate,
} from "@/lib/maintenance-templates";
import { todayEastern } from "@/lib/eastern-date";

const PACK_MARKER = "maintenance pack proposed for truck";

export interface PackStageOutcome {
  staged: number;
  /** Presentation text for the reply (includes the proposal list when staged > 0). */
  text: string;
}

export async function stageMaintenancePack(
  store: BotBrainStore,
  truckId: string,
): Promise<PackStageOutcome> {
  const { client, companyId } = store;

  const { data: truckData, error: truckError } = await client
    .from("trucks")
    .select("id, unit_number")
    .eq("id", truckId)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .maybeSingle();
  if (truckError) throw new Error(truckError.message);
  if (!truckData) throw new Error("That truck isn't in his records.");
  const truck = truckData as { id: string; unit_number: string };

  // Already proposed once? The marker is Abel's own bookkeeping
  // memory - the same store his facts live in.
  const memories = await store.loadMemories();
  const marker = `${PACK_MARKER} ${truck.unit_number} `;
  if (memories.some((m) => m.content.includes(marker))) {
    return {
      staged: 0,
      text: `I already proposed the standard maintenance pack for truck ${truck.unit_number} once - I don't re-propose it on my own. If you want it again, say "propose the maintenance pack" and I'll stage it fresh.`,
    };
  }

  const { data: scheduleData, error: scheduleError } = await client
    .from("maintenance_schedules")
    .select("description, template_key")
    .eq("company_id", companyId)
    .eq("truck_id", truckId)
    .is("deleted_at", null);
  if (scheduleError) throw new Error(scheduleError.message);
  const existing = (scheduleData ?? []) as { description: string; template_key: string | null }[];
  const coveredKeys = new Set(existing.map((s) => s.template_key).filter(Boolean));
  const coveredLabels = new Set(existing.map((s) => s.description.toLowerCase()));
  const missing: MaintenanceTemplate[] = MAINTENANCE_TEMPLATES.filter(
    (t) => !coveredKeys.has(t.key) && !coveredLabels.has(t.label.toLowerCase()),
  );

  if (missing.length === 0) {
    return {
      staged: 0,
      text: `Truck ${truck.unit_number} already has the full standard maintenance pack tracked - nothing new to propose.`,
    };
  }

  const tool = buildBotTools(store).find((t) => t.name === "create_maintenance_schedule");
  if (!tool?.validateArgs || !tool.summarize) {
    throw new Error("The maintenance schedule tool isn't available to stage the pack.");
  }
  const batchId = randomUUID();
  const views: { summary: string; sourceQuote?: string | null; confidence?: string | null }[] = [];
  let itemNumber = 0;
  for (const template of missing) {
    const args: Record<string, unknown> = {
      truck_id: truckId,
      description: template.label,
      template_key: template.key,
      origin: "template",
    };
    if (template.intervalMiles != null) args.interval_miles = template.intervalMiles;
    if (template.intervalDays != null) args.interval_days = template.intervalDays;
    const validation = tool.validateArgs(args);
    if (!validation.ok) {
      console.error(`[maintenance-seeding] pack item ${template.key} failed validation: ${validation.error}`);
      continue;
    }
    itemNumber += 1;
    const summary = tool.summarize(validation.args);
    await store.savePendingAction({
      toolName: "create_maintenance_schedule",
      args: validation.args,
      summary,
      batchId,
      itemNumber,
      sourceQuote: `standard pack - every ${template.intervalMiles != null ? `${template.intervalMiles.toLocaleString("en-US")} mi` : ""}${template.intervalMiles != null && template.intervalDays != null ? " / " : ""}${template.intervalDays != null ? `${template.intervalDays} days` : ""}`,
      confidence: "high",
    });
    views.push({ summary, sourceQuote: null, confidence: null });
  }

  // The once-per-truck marker lands even if he rejects the pack -
  // "proposed once" means proposed once.
  await store.saveMemory(
    "fact",
    `${marker}(unit ${truck.unit_number}, id ${truckId}) on ${todayEastern()}: ${views.length} schedules proposed from the standard library.`,
  );

  const text =
    `Here's the standard maintenance pack for truck ${truck.unit_number} - the set of schedules worth tracking on any Class 8 truck. ` +
    `${TEMPLATE_HONESTY_LABEL} Each one starts with NO last-done recorded, so it'll show "unknown" until you tell me when it was last done - I'm not inventing a history for the truck.` +
    formatBatchProposal(views);
  return { staged: views.length, text };
}
