// Paper-log staging (Image Intelligence design §7): turns one
// sheet's analyzed read into a single propose->approve batch -
// the paper's segments as duty rows (source 'paper_photo', the
// sheet's document id riding along), plus, when app/conversation
// rows already cover spans the paper covers, paper-wins
// replacement proposals (§7.6: the paper is the legal record; the
// replaced rows are soft-deleted by the delete tool, recoverable,
// and the proposal text points at the sheet).
//
// Doctrine, enforced here in code: hours are NEVER invented -
// segments under the §7.4 floor are absent from the batch and
// named in the reply instead; a partial day is stamped partial
// on the document and labeled partial in every reply; a late
// sheet names what it does to his 70-hour picture when it moves
// it (§7.6 backfill).

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizeHos } from "@/lib/hos";
import { zonedInstant } from "@/lib/zoned-day";
import { PAPER_REMARK_LINE } from "@/lib/paper-day";
import type { DutyLog, Load } from "@/types/entities";
import type { BotBrainStore } from "@/services/bot/store";
import { buildBotTools } from "@/services/bot/tools";
import {
  analyzePaperLogDay,
  minutesToTime,
  type PaperLogExtraction,
} from "@/services/ai/paper-log-extraction";

/** §7.6: any correction to a paper-sourced row carries this line (defined in lib/paper-day.ts so the app can show it too). */
export { PAPER_REMARK_LINE };

const STATUS_LABELS: Record<string, string> = {
  off_duty: "off duty",
  sleeper: "sleeper berth",
  driving: "driving",
  on_duty: "on duty (not driving)",
};

// ---------------------------------------------------------------------
// Sheet-local times -> timestamps (the sheet's day is a local day)
// ---------------------------------------------------------------------

/** The UTC instant of a wall-clock time on the sheet's date, in his timezone. */
export function paperSheetInstant(logDate: string, hhmm: string, timeZone = "America/New_York"): Date {
  return zonedInstant(logDate, hhmm, timeZone);
}

function formatClock(minutes: number): string {
  const time = minutesToTime(minutes);
  const [hRaw, m] = time.split(":").map((part) => Number.parseInt(part, 10));
  const h = hRaw ?? 0;
  if (h === 24) return "midnight";
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(2).replace(/0$/, "")}h`;
}

function dayLabel(logDate: string): string {
  const weekday = new Date(`${logDate}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "America/New_York",
  });
  return `${weekday} (${logDate})`;
}

// ---------------------------------------------------------------------
// The staging pipeline
// ---------------------------------------------------------------------

export interface StagePaperLogDeps {
  store: BotBrainStore;
  documentId: string;
  extraction: PaperLogExtraction;
}

interface ExistingSpan {
  row: DutyLog & { source?: string; source_document_id?: string | null };
  startMs: number;
  endMs: number;
}

export async function stagePaperLogDay(deps: StagePaperLogDeps): Promise<{ lines: string[] }> {
  const { store, documentId, extraction } = deps;
  const { client, companyId } = store;
  const analysis = analyzePaperLogDay(extraction);
  const lines: string[] = [];

  if (!extraction.log_date) {
    lines.push(
      "I read the sheet's grid as far as I could, but the date itself wasn't readable — and an undated day can't go into your hours. Tell me the date in words and I'll stage it, or send a clearer photo of the top of the sheet.",
    );
    await stampPaperDocument(client, companyId, documentId, false, null);
    return { lines };
  }
  const logDate = extraction.log_date;
  const label = dayLabel(logDate);
  const dayStart = paperSheetInstant(logDate, "00:00");
  const dayEnd = paperSheetInstant(logDate, "24:00");

  // The day's stamp lands whatever he decides - it describes the
  // READ (§7.5), not the landing.
  await stampPaperDocument(client, companyId, documentId, analysis.complete, logDate);

  // Existing rows around the day, as spans (a row runs until the
  // next row starts). Rows from THIS sheet (a re-settle) never
  // conflict with themselves.
  const { data: around } = await client
    .from("duty_logs")
    .select("*")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .gte("started_at", new Date(dayStart.getTime() - 86_400_000).toISOString())
    .lt("started_at", dayEnd.toISOString())
    .order("started_at", { ascending: true });
  const aroundRows = (around ?? []) as ExistingSpan["row"][];
  const spans: ExistingSpan[] = aroundRows.map((row, index) => ({
    row,
    startMs: new Date(row.started_at).getTime(),
    endMs: aroundRows[index + 1] ? new Date(aroundRows[index + 1]!.started_at).getTime() : dayEnd.getTime(),
  }));
  const stagedSpans = analysis.staged.map((segment) => ({
    segment,
    startMs: paperSheetInstant(logDate, segment.start).getTime(),
    endMs: paperSheetInstant(logDate, segment.end).getTime(),
  }));
  const conflicts = spans.filter(
    (span) =>
      span.endMs > dayStart.getTime() &&
      span.row.source_document_id !== documentId &&
      stagedSpans.some((s) => span.startMs < s.endMs && s.startMs < span.endMs),
  );

  // Load inference (§7.3): window covers the date; a truck-unit
  // match narrows. One candidate -> attached and named; more (or
  // none) -> the day stands on its own, which is a complete state.
  const inferred = await inferLoad(client, companyId, logDate, extraction.truck_number);
  const attachedLoad: Load | null = inferred !== null && inferred !== "ambiguous" ? inferred : null;
  const ambiguousLoads = inferred === "ambiguous";

  // 70-hour backfill effect (§7.6): before vs after on the real
  // 8-day window, computed - never asserted.
  const { data: windowRows } = await client
    .from("duty_logs")
    .select("*")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(200);
  const currentRows = (windowRows ?? []) as DutyLog[];
  const beforeMinutes = currentRows.length > 0 ? summarizeHos(currentRows).onDutyMinutesLast8Days : 0;
  const conflictIds = new Set(conflicts.map((c) => c.row.id));
  const afterRows: DutyLog[] = [
    ...currentRows.filter((row) => !conflictIds.has(row.id)),
    ...stagedSpans.map((s, index) => ({
      id: `paper-staged-${index}`,
      company_id: companyId,
      driver_id: null,
      load_id: attachedLoad ? attachedLoad.id : null,
      duty_status: s.segment.status,
      started_at: new Date(s.startMs).toISOString(),
      location: null,
      odometer: null,
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    }) as DutyLog),
  ];
  const afterMinutes = afterRows.length > 0 ? summarizeHos(afterRows).onDutyMinutesLast8Days : 0;

  // ---- Stage the batch (deletes first, then the paper's rows) --
  // Pending-action confidence is a word, house convention
  // (vehicle-photos' confWord): the segment's number, bucketed.
  const confWord = (confidence: number): string => (confidence >= 0.95 ? "high" : "medium");
  const items: { toolName: string; args: Record<string, unknown>; summary: string; confidence: string }[] = [];
  for (const conflict of conflicts) {
    items.push({
      toolName: "delete_record",
      args: { entity: "duty_log", record_id: conflict.row.id },
      summary:
        `Replace the app's ${STATUS_LABELS[conflict.row.duty_status] ?? conflict.row.duty_status} entry from ${new Date(conflict.row.started_at).toLocaleString("en-US", { timeZone: "America/New_York" })} — ` +
        `the paper sheet for ${label} says otherwise, and the paper is your legal record. The replaced entry is soft-deleted (recoverable) and this proposal points at the sheet photo as the reason.`,
      confidence: "high",
    });
  }
  for (const { segment } of stagedSpans) {
    items.push({
      toolName: "log_duty_status",
      args: {
        duty_status: segment.status,
        started_at: paperSheetInstant(logDate, segment.start).toISOString(),
        ...(attachedLoad ? { load_id: attachedLoad.id } : {}),
        source: "paper_photo",
        source_document_id: documentId,
        notes: segment.flagged
          ? "Read from the paper log sheet photo — this change was faint on the grid; double-check it against the sheet."
          : "Read from the paper log sheet photo.",
      },
      summary:
        `Paper log: ${STATUS_LABELS[segment.status] ?? segment.status} from ${formatClock(segment.startMin)} on ${label}` +
        (segment.flagged ? ` — ⚠ double-check this change against the sheet (the line was faint or the day's arithmetic disagreed)` : ""),
      confidence: confWord(segment.confidence),
    });
  }

  let stagedCount = 0;
  if (items.length > 0) {
    const tools = buildBotTools(store);
    const batchId = randomUUID();
    let itemNumber = 0;
    for (const item of items) {
      const tool = tools.find((t) => t.name === item.toolName);
      if (!tool?.validateArgs) continue;
      const validation = tool.validateArgs(item.args);
      if (!validation.ok) {
        console.error(`[paper-logs] staged item ${item.toolName} failed validation: ${validation.error}`);
        continue;
      }
      itemNumber += 1;
      await store.savePendingAction({
        toolName: item.toolName,
        args: validation.args,
        summary: item.summary,
        batchId,
        itemNumber,
        confidence: item.confidence,
      });
      stagedCount += 1;
    }
  }

  // ---- The reply: the day he read, in full (§7.1, §7.4-§7.6) ---
  const totalsByStatus = new Map<string, number>();
  for (const segment of analysis.staged) {
    totalsByStatus.set(segment.status, (totalsByStatus.get(segment.status) ?? 0) + (segment.endMin - segment.startMin));
  }
  const totalsText = [...totalsByStatus.entries()]
    .map(([status, minutes]) => `${STATUS_LABELS[status] ?? status} ${formatHours(minutes)}`)
    .join(", ");
  lines.push(
    analysis.staged.length > 0
      ? `Read your paper log for ${label}: ${totalsText}.`
      : `I couldn't stage any of ${label} from that sheet — nothing on it cleared the bar for moving your legal clocks.`,
  );
  if (extraction.truck_number) {
    lines.push(`Sheet shows truck ${extraction.truck_number}${extraction.trailer_number ? `, trailer ${extraction.trailer_number}` : ""}.`);
  }
  for (const problem of analysis.problems) lines.push(`⚠ ${problem}`);
  for (const segment of analysis.staged.filter((s) => s.flagged)) {
    lines.push(
      `Double-check the ${formatClock(segment.startMin)} change to ${STATUS_LABELS[segment.status] ?? segment.status} — the line was faint. Your yes should be an informed yes.`,
    );
  }
  for (const segment of analysis.dropped) {
    lines.push(
      `I couldn't read the ${STATUS_LABELS[segment.status] ?? segment.status} stretch around ${formatClock(segment.startMin)}–${formatClock(segment.endMin)} well enough to use it — I left it out rather than guess. Tell me in words when you changed status there and I'll add it as your word, not the reader's guess.`,
    );
  }
  for (const span of analysis.missingSpans) {
    if (span.startMin < 0) {
      lines.push("Part of the sheet was unreadable in a way I couldn't locate on the clock — that part isn't in these numbers.");
    } else {
      lines.push(
        `${formatClock(span.startMin)}–${formatClock(span.endMin)} is missing from what I could read — I left it out, so your clocks are computed only from the readable part of ${label} until you tell me the rest. Hours are never filled in by guessing.`,
      );
    }
  }
  if (conflicts.length > 0) {
    lines.push(
      `The paper disagrees with ${conflicts.length} existing entr${conflicts.length === 1 ? "y" : "ies"} for that day. Paper is your legal record, so the proposal below replaces them (paper-wins) — nothing is overwritten silently; your yes decides, and replaced entries stay recoverable.`,
    );
  }
  if (attachedLoad) {
    lines.push(`Attached to the ${attachedLoad.origin} → ${attachedLoad.destination} load, whose window covers that day.`);
  } else if (ambiguousLoads) {
    lines.push("More than one load could cover that day, so I left the load off the entries — a log day with no load is a complete state; tell me which load and I'll attach it.");
  }
  if (afterMinutes !== beforeMinutes) {
    lines.push(
      `Adding this day changes your 70-hour picture: on-duty in the last 8 days goes from ${formatHours(beforeMinutes)} to ${formatHours(afterMinutes)} of 70h.`,
    );
  }
  if (stagedCount > 0) {
    lines.push(
      analysis.complete
        ? "Say yes and these become your app hours, marked as read from the paper — the sheet stays your legal record, the app just mirrors it."
        : `Say yes and the readable part becomes your app hours, marked partial — from the readable part of ${label}. The missing spans stay missing until you supply them.`,
    );
  }
  return { lines };
}

async function inferLoad(
  client: SupabaseClient,
  companyId: string,
  logDate: string,
  truckNumber: string | null,
): Promise<Load | "ambiguous" | null> {
  const { data } = await client
    .from("loads")
    .select("*")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .limit(100);
  const loads = (data ?? []) as Load[];
  const covering = loads.filter((load) => {
    if (load.pickup_date == null && load.delivery_date == null) return false;
    if (load.pickup_date != null && load.pickup_date > logDate) return false;
    if (load.delivery_date != null && load.delivery_date < logDate) return false;
    return true;
  });
  if (covering.length === 0) return null;
  if (covering.length === 1) return covering[0]!;
  if (truckNumber) {
    // §7.3 order (1): the sheet's truck number, matched against
    // the profile, narrows the field before anything is called
    // ambiguous.
    const { data: truckRow } = await client
      .from("trucks")
      .select("id")
      .eq("company_id", companyId)
      .eq("unit_number", truckNumber)
      .is("deleted_at", null)
      .maybeSingle();
    const truckId = (truckRow as { id: string } | null)?.id;
    if (truckId) {
      const matched = covering.filter((load) => load.truck_id === truckId);
      if (matched.length === 1) return matched[0]!;
    }
  }
  return "ambiguous";
}

async function stampPaperDocument(
  client: SupabaseClient,
  companyId: string,
  documentId: string,
  complete: boolean,
  logDate: string | null,
): Promise<void> {
  try {
    const { data } = await client
      .from("documents")
      .select("extracted_fields")
      .eq("id", documentId)
      .eq("company_id", companyId)
      .maybeSingle();
    const existing = ((data as { extracted_fields: Record<string, unknown> | null } | null)?.extracted_fields ?? {}) as Record<string, unknown>;
    const { error } = await client
      .from("documents")
      .update({
        extracted_fields: { ...existing, paper_log_complete: complete, paper_log_date: logDate },
      })
      .eq("id", documentId)
      .eq("company_id", companyId);
    if (error) console.error("[paper-logs] document stamp failed", error.message);
  } catch (err) {
    console.error("[paper-logs] document stamp failed", err);
  }
}

// ---------------------------------------------------------------------
// Provenance labeling (§7.7.1) + edit discipline (§7.6)
// ---------------------------------------------------------------------

interface PaperAwareRow {
  source?: string | null;
  source_document_id?: string | null;
}

/**
 * The labeling every clock surface owes him: paper-sourced clocks
 * say so, mixed clocks say so, and a day whose sheet didn't read
 * in full says "partial — from the readable part of [date]'s log".
 * Pre-00047 rows simply have no source field - no label, no error.
 */
export async function hosProvenanceLines(
  client: SupabaseClient,
  companyId: string,
  rows: PaperAwareRow[],
): Promise<string[]> {
  const paperRows = rows.filter((row) => row.source === "paper_photo");
  if (paperRows.length === 0) return [];
  const lines: string[] = [
    paperRows.length === rows.length
      ? "Every hour in this picture was read off your paper log sheet(s) — the paper stays the legal record; the app mirrors it."
      : "This picture mixes app entries with hours read off your paper log sheet(s) — where they differ, the paper is the legal record.",
  ];
  const docIds = [...new Set(paperRows.map((row) => row.source_document_id).filter(Boolean))] as string[];
  if (docIds.length > 0) {
    const { data } = await client
      .from("documents")
      .select("id, extracted_fields")
      .eq("company_id", companyId)
      .in("id", docIds);
    for (const doc of (data ?? []) as { id: string; extracted_fields: Record<string, unknown> | null }[]) {
      const fields = doc.extracted_fields ?? {};
      if (fields.paper_log_complete === false) {
        const date = typeof fields.paper_log_date === "string" ? fields.paper_log_date : "that day";
        lines.push(`⚠ Partial — from the readable part of ${date}'s log; the unreadable spans aren't in these numbers.`);
      }
    }
  }
  return lines;
}

/**
 * §7.6 correction discipline, at the one seam every Telegram edit
 * proposal passes through: a delete aimed at a paper-sourced duty
 * row gets the re-mark line appended to its proposal text, so his
 * yes is informed that the paper itself still says the old time.
 */
export async function annotatePaperLogEdits<
  T extends { tool: string; args: Record<string, unknown>; summary: string },
>(store: BotBrainStore, proposals: T[]): Promise<T[]> {
  const out = [...proposals];
  for (let i = 0; i < out.length; i += 1) {
    const proposal = out[i]!;
    if (proposal.tool !== "delete_record" || proposal.args.entity !== "duty_log") continue;
    const recordId = proposal.args.record_id;
    if (typeof recordId !== "string") continue;
    const { data } = await store.client
      .from("duty_logs")
      .select("source")
      .eq("id", recordId)
      .eq("company_id", store.companyId)
      .maybeSingle();
    if ((data as { source?: string } | null)?.source === "paper_photo") {
      out[i] = { ...proposal, summary: `${proposal.summary} ${PAPER_REMARK_LINE}` };
    }
  }
  return out;
}
