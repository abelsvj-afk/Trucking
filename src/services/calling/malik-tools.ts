// Malik's real tools (design docs/design/malik-real-tools.md).
// The Telnyx phone voice, doing dispatcher work on live calls: the six
// webhook tools below read the owner's own company data through the
// service-role client, scoped to one company id in code. Every call is
// logged to malik_tool_calls; every message taken and every call summary
// is reported to Abel (the coordinator) via malik_call_reports + the
// Telegram group when it is configured.
//
// Propose-only guardrail, by construction: five of the six tools are
// read-only, and the sixth (take_message) only records a message — it
// never books, pays, signs, or moves money, and never offers a human
// handoff. Nothing here invents a load detail: a missing load, route,
// or position is said plainly, in the tool's own words.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { buildActiveLoadState, describeActiveLoadState } from "@/services/navigation/active-load-state";
import { loadHosWindow, cycleLine, hosWarnings } from "@/services/api/hos-window";
import { computeDetention } from "@/lib/detention";
import { computePaperwork } from "@/lib/paperwork";
import { pickActiveLoad } from "@/lib/active-load";
import { todayEastern } from "@/lib/eastern-date";
import { formatMoney } from "@/lib/money-format";
import { formatClock, formatDateTime, HOME_TIME_ZONE } from "@/lib/display-zone";
import { createBotTeamStore } from "@/services/bots/store";
import { sendTelegramMessage } from "@/services/telegram/bot-api";
import type { DetentionStamp, Document, DutyLog, Expense, Load } from "@/types/entities";

export const MALIK_TOOL_NAMES = [
  "malik_get_active_load",
  "malik_get_delivery_eta",
  "malik_get_hos_hours",
  "malik_get_trip_status",
  "malik_get_load_paperwork",
  "malik_take_message",
] as const;

export type MalikToolName = (typeof MALIK_TOOL_NAMES)[number];

export function isMalikToolName(value: string): value is MalikToolName {
  return (MALIK_TOOL_NAMES as readonly string[]).includes(value);
}

const tripNumberArgs = z.object({
  trip_number: z.string().trim().min(1).max(40).optional(),
});

const loadIdArgs = z.object({
  load_id: z.string().uuid(),
});

const takeMessageArgs = z.object({
  caller_name: z.string().trim().min(1).max(120),
  callback_number: z.string().trim().min(1).max(40).optional(),
  message: z.string().trim().min(1).max(1000),
  load_ref: z.string().trim().min(1).max(40).optional(),
});

const emptyArgs = z.object({});

const TOOL_ARG_SCHEMAS: Record<MalikToolName, z.ZodType<Record<string, unknown>>> = {
  malik_get_active_load: tripNumberArgs,
  malik_get_delivery_eta: emptyArgs,
  malik_get_hos_hours: emptyArgs,
  malik_get_trip_status: emptyArgs,
  malik_get_load_paperwork: loadIdArgs,
  malik_take_message: takeMessageArgs,
};

function minutesText(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** A load's appointment window in its own zone, else home time — always labeled. */
function windowText(
  start: string | null | undefined,
  end: string | null | undefined,
  zone: string | null | undefined,
  fallbackDate: string | null | undefined,
): string {
  const tz = zone ?? HOME_TIME_ZONE;
  if (start && end) return `${formatDateTime(start, tz)} to ${formatDateTime(end, tz)}`;
  if (start) return `from ${formatDateTime(start, tz)}`;
  if (end) return `by ${formatDateTime(end, tz)}`;
  return fallbackDate ?? "no time on file";
}

async function loadRow(
  client: SupabaseClient,
  companyId: string,
  loadId: string,
): Promise<Load | null> {
  const { data, error } = await client
    .from("loads")
    .select("*")
    .eq("company_id", companyId)
    .eq("id", loadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Load | null) ?? null;
}

async function brokerName(client: SupabaseClient, companyId: string, brokerId: string | null): Promise<string | null> {
  if (!brokerId) return null;
  const { data, error } = await client
    .from("brokers")
    .select("name")
    .eq("company_id", companyId)
    .eq("id", brokerId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { name: string }).name;
}

function formatLoadForCall(load: Load, broker: string | null): string {
  const lines = [
    `Trip ${load.trip_number ?? load.id.slice(0, 8)}: ${load.origin} → ${load.destination} (${load.status}).`,
    `Pickup: ${windowText(load.pickup_window_start, load.pickup_window_end, load.pickup_tz, load.pickup_date)}.`,
    `Delivery: ${windowText(load.delivery_window_start, load.delivery_window_end, load.delivery_tz, load.delivery_date)}.`,
  ];
  if (typeof load.rate_cents === "number") lines.push(`Rate on file: ${formatMoney(load.rate_cents)}.`);
  if (typeof load.miles === "number") lines.push(`Miles: ${load.miles}.`);
  if (broker) lines.push(`Broker: ${broker}.`);
  return lines.join("\n");
}

async function getActiveLoad(
  client: SupabaseClient,
  companyId: string,
  args: { trip_number?: string },
): Promise<string> {
  let load: Load | null = null;
  if (args.trip_number) {
    const { data, error } = await client
      .from("loads")
      .select("*")
      .eq("company_id", companyId)
      .eq("trip_number", args.trip_number)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    load = (data as Load | null) ?? null;
    if (!load) return `No load with trip number ${args.trip_number} in his records.`;
  } else {
    const { data, error } = await client
      .from("loads")
      .select("*")
      .eq("company_id", companyId)
      .eq("status", "confirmed")
      .is("deleted_at", null);
    if (error) throw new Error(error.message);
    const picked = pickActiveLoad((data ?? []) as Load[], todayEastern());
    if (!picked) return "No active load: no confirmed load is on the books right now.";
    load = picked.load;
  }
  const broker = await brokerName(client, companyId, load.broker_id);
  return formatLoadForCall(load, broker);
}

async function getDeliveryEta(client: SupabaseClient, companyId: string): Promise<string> {
  const state = await buildActiveLoadState(client, companyId);
  if (!state.load) return "No active load: no confirmed load is on the books right now.";
  const lines = [describeActiveLoadState(state)];
  const load = await loadRow(client, companyId, state.load.id);
  if (load) {
    lines.push(
      `Delivery window: ${windowText(load.delivery_window_start, load.delivery_window_end, load.delivery_tz, load.delivery_date)}.`,
    );
  }
  try {
    const snapshot = await loadHosWindow(client, companyId);
    const driveLeftMin = 11 * 60 - snapshot.short.drivingMinutesInWindow;
    const windowLeftMin = 14 * 60 - snapshot.short.windowElapsedMinutes;
    lines.push(
      `His hours: ${minutesText(driveLeftMin)} of driving left in the 14-hour window (${minutesText(windowLeftMin)} of the window left).`,
    );
    const warnings = hosWarnings(snapshot);
    if (warnings.length > 0) lines.push(`Hours warnings: ${warnings.join("; ")}`);
  } catch {
    lines.push("His hours couldn't be read just now, so I can't say how much drive time he has left.");
  }
  return lines.join("\n");
}

/** The HOS lines, in the same words as Abel's hos_summary (same snapshot, same engine). */
export function formatHosSnapshot(snapshot: Awaited<ReturnType<typeof loadHosWindow>>): string {
  const rows = snapshot.rows;
  if (rows.length === 0) return "No duty logs in the current HOS window.";
  const hos = snapshot.short;
  const current = rows[rows.length - 1]!;
  const lines = [
    `Current duty status: ${current.duty_status} (since ${formatClock(current.started_at, HOME_TIME_ZONE)}).`,
    `Driving in current 14h window: ${minutesText(hos.drivingMinutesInWindow)} of 11h.`,
    `Window elapsed: ${minutesText(hos.windowElapsedMinutes)} of 14h.`,
    `Driving since last 30-min break: ${minutesText(hos.drivingMinutesSinceBreak)} of 8h.`,
    cycleLine(snapshot),
  ];
  const warnings = hosWarnings(snapshot);
  if (warnings.length > 0) lines.push(`Warnings: ${warnings.join("; ")}`);
  return lines.join("\n");
}

async function getHosHours(client: SupabaseClient, companyId: string): Promise<string> {
  return formatHosSnapshot(await loadHosWindow(client, companyId));
}

async function getTripStatus(client: SupabaseClient, companyId: string): Promise<string> {
  const state = await buildActiveLoadState(client, companyId);
  if (!state.load) return "No active load: no confirmed load is on the books right now.";
  const lines = [describeActiveLoadState(state)];
  const [dutyResult, stampsResult] = await Promise.all([
    client
      .from("duty_logs")
      .select("duty_status, started_at")
      .eq("company_id", companyId)
      .order("started_at", { ascending: false })
      .limit(1),
    client
      .from("detention_stamps")
      .select("*")
      .eq("company_id", companyId)
      .eq("load_id", state.load.id)
      .is("deleted_at", null)
      .order("occurred_at", { ascending: true }),
  ]);
  if (!dutyResult.error && dutyResult.data && dutyResult.data.length > 0) {
    const row = (dutyResult.data as DutyLog[])[0]!;
    lines.push(`Current duty status: ${row.duty_status} (since ${formatClock(row.started_at, HOME_TIME_ZONE)}).`);
  }
  if (!stampsResult.error) {
    const load = await loadRow(client, companyId, state.load.id);
    if (load) {
      const summary = computeDetention(load, (stampsResult.data ?? []) as DetentionStamp[]);
      if (summary.totalOwedCents != null && summary.totalOwedCents > 0) {
        lines.push(`Detention owed so far: ${formatMoney(summary.totalOwedCents)}.`);
      } else if (summary.anyClockOpen) {
        lines.push("The detention clock is running at the facility.");
      }
    }
  }
  return lines.join("\n");
}

async function getLoadPaperwork(
  client: SupabaseClient,
  companyId: string,
  args: { load_id: string },
): Promise<string> {
  const load = await loadRow(client, companyId, args.load_id);
  if (!load) return "That load isn't in his records.";
  const [docsResult, expensesResult] = await Promise.all([
    client
      .from("documents")
      .select("id, doc_type")
      .eq("company_id", companyId)
      .eq("related_entity_type", "load")
      .eq("related_entity_id", load.id),
    client
      .from("expenses")
      .select("category, description")
      .eq("company_id", companyId)
      .eq("load_id", load.id)
      .is("deleted_at", null),
  ]);
  if (docsResult.error) throw new Error(docsResult.error.message);
  if (expensesResult.error) throw new Error(expensesResult.error.message);
  const state = computePaperwork(
    load,
    (docsResult.data ?? []) as Pick<Document, "id" | "doc_type">[],
    (expensesResult.data ?? []) as Pick<Expense, "category" | "description">[],
  );
  const lines = state.items.map(
    (item) => `- ${item.present ? "✓" : "✗"} ${item.label}${item.present ? "" : ` — ${item.why}`}`,
  );
  return `Paperwork for ${load.origin} → ${load.destination}:\n${lines.join("\n")}\n${state.summaryLine}`;
}

export interface MalikCallReportInput {
  kind: "message" | "call-summary";
  telnyxConversationId?: string | null;
  callerName?: string | null;
  callbackNumber?: string | null;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
}

export interface MalikReportOutcome {
  id: string | null;
  postedToGroup: boolean;
}

/**
 * Post a Malik report into the Telegram group so Abel (and the owner)
 * see it in the room. Best-effort by design: when the group is not
 * configured, or the send fails, the report still exists in the
 * database and Abel's list_malik_call_reports tool surfaces it.
 * Returns whether the group actually got it.
 */
export async function postMalikReportToGroup(
  companyId: string,
  title: string,
  body: string,
): Promise<{ posted: boolean; telegramMessageId: number | null }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const groupChatIdRaw = process.env.TELEGRAM_GROUP_CHAT_ID ?? "";
  const groupChatId = Number(groupChatIdRaw);
  if (!botToken || !groupChatIdRaw || !Number.isFinite(groupChatId)) return { posted: false, telegramMessageId: null };
  try {
    const store = createBotTeamStore(companyId);
    if (!store) return { posted: false, telegramMessageId: null };
    await store.ensureGroupRoom(groupChatId, "Road to Legacy Crew");
    const text = `Malik — ${title}\n${body}`.slice(0, 4000);
    const ids = await sendTelegramMessage(botToken, groupChatId, text);
    const messageId = ids[0] ?? null;
    if (messageId === null) return { posted: false, telegramMessageId: null };
    await store.recordGroupMessage({
      telegramChatId: groupChatId,
      telegramMessageId: messageId,
      senderKind: "bot",
      senderRef: "malik",
      text,
      routedToBotSlug: "abel",
    });
    return { posted: true, telegramMessageId: messageId };
  } catch (err) {
    console.error("[malik] group report post failed", err);
    return { posted: false, telegramMessageId: null };
  }
}

/**
 * Record a Malik call report. A call-summary is one row per Telnyx
 * conversation (upserted by conversation id, never duplicated); a
 * message is always a new row. The group post is attempted after the
 * row lands, and the row is updated with the outcome — so the database
 * always says honestly whether Abel's room got it. A row that already
 * reached the group is never posted twice: the first event with real
 * content posts it, later fills only update the record.
 */
export async function recordMalikCallReport(
  client: SupabaseClient,
  companyId: string,
  input: MalikCallReportInput,
  opts: { postToGroup?: boolean; onlyCreate?: boolean } = {},
): Promise<MalikReportOutcome> {
  let id: string | null = null;
  let alreadyPosted = false;
  if (input.kind === "call-summary" && input.telnyxConversationId) {
    const { data: existing } = await client
      .from("malik_call_reports")
      .select("id, reported_to_group")
      .eq("company_id", companyId)
      .eq("kind", "call-summary")
      .eq("telnyx_conversation_id", input.telnyxConversationId)
      .maybeSingle();
    const row = {
      company_id: companyId,
      kind: input.kind,
      telnyx_conversation_id: input.telnyxConversationId,
      caller_name: input.callerName ?? null,
      callback_number: input.callbackNumber ?? null,
      title: input.title,
      body: input.body,
      payload: input.payload ?? {},
    };
    if (existing) {
      const existingId = (existing as { id: string }).id;
      alreadyPosted = (existing as { reported_to_group?: boolean }).reported_to_group === true;
      if (!opts.onlyCreate) {
        const { error } = await client
          .from("malik_call_reports")
          .update({ title: row.title, body: row.body, payload: row.payload })
          .eq("id", existingId);
        if (error) throw new Error(error.message);
      }
      id = existingId;
    } else {
      const { data, error } = await client.from("malik_call_reports").insert(row).select("id").single();
      if (error) throw new Error(error.message);
      id = (data as { id: string }).id;
    }
  } else {
    const { data, error } = await client
      .from("malik_call_reports")
      .insert({
        company_id: companyId,
        kind: input.kind,
        telnyx_conversation_id: input.telnyxConversationId ?? null,
        caller_name: input.callerName ?? null,
        callback_number: input.callbackNumber ?? null,
        title: input.title,
        body: input.body,
        payload: input.payload ?? {},
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    id = (data as { id: string }).id;
  }
  const shouldPost = (opts.postToGroup ?? true) && !alreadyPosted;
  const posted = shouldPost ? await postMalikReportToGroup(companyId, input.title, input.body) : { posted: alreadyPosted, telegramMessageId: null };
  if (id && shouldPost) {
    const { error } = await client
      .from("malik_call_reports")
      .update({ reported_to_group: posted.posted, telegram_message_id: posted.telegramMessageId })
      .eq("id", id);
    if (error) console.error("[malik] report group-flag update failed", error);
  }
  return { id, postedToGroup: alreadyPosted || posted.posted };
}

async function takeMessage(
  client: SupabaseClient,
  companyId: string,
  args: { caller_name: string; callback_number?: string; message: string; load_ref?: string },
): Promise<string> {
  const title = `Message from ${args.caller_name}${args.load_ref ? ` — Trip ${args.load_ref}` : ""}`;
  const bodyLines = [args.message];
  if (args.callback_number) bodyLines.push(`Call back: ${args.callback_number}.`);
  const body = bodyLines.join("\n");
  const outcome = await recordMalikCallReport(client, companyId, {
    kind: "message",
    callerName: args.caller_name,
    callbackNumber: args.callback_number ?? null,
    title,
    body,
    payload: { caller_name: args.caller_name, callback_number: args.callback_number ?? null, message: args.message, load_ref: args.load_ref ?? null },
  });
  return (
    `Got it — I'll pass that to Abel: message from ${args.caller_name}` +
    `${args.callback_number ? ` (${args.callback_number})` : ""}` +
    `${outcome.postedToGroup ? " — it's in the group chat for him." : " — it's saved for him to pick up."}`
  );
}

const TOOL_RUNNERS: Record<MalikToolName, (client: SupabaseClient, companyId: string, args: Record<string, unknown>) => Promise<string>> = {
  malik_get_active_load: (c, id, a) => getActiveLoad(c, id, a as { trip_number?: string }),
  malik_get_delivery_eta: (c, id) => getDeliveryEta(c, id),
  malik_get_hos_hours: (c, id) => getHosHours(c, id),
  malik_get_trip_status: (c, id) => getTripStatus(c, id),
  malik_get_load_paperwork: (c, id, a) => getLoadPaperwork(c, id, a as { load_id: string }),
  malik_take_message: (c, id, a) =>
    takeMessage(c, id, a as { caller_name: string; callback_number?: string; message: string; load_ref?: string }),
};

/** Append-only tool-call log. A logging failure is loud in the server log but never fails the answer. */
export async function logMalikToolCall(
  client: SupabaseClient,
  companyId: string,
  entry: {
    toolName: MalikToolName;
    args: Record<string, unknown>;
    resultText: string;
    durationMs: number;
    conversationRef?: string | null;
  },
): Promise<void> {
  try {
    const { error } = await client.from("malik_tool_calls").insert({
      company_id: companyId,
      tool_name: entry.toolName,
      args: entry.args,
      result_text: entry.resultText.slice(0, 2000),
      duration_ms: entry.durationMs,
      conversation_ref: entry.conversationRef ?? null,
    });
    if (error) console.error("[malik] tool-call log failed", error);
  } catch (err) {
    console.error("[malik] tool-call log failed", err);
  }
}

/**
 * Run one Malik tool call end to end: validate the arguments, run the
 * handler, log the call, and return the grounding text for the
 * assistant. A handler failure returns an honest plain-words line —
 * never an invented answer, never an internal error string.
 */
export async function runMalikTool(
  client: SupabaseClient,
  companyId: string,
  toolName: MalikToolName,
  rawArgs: Record<string, unknown>,
): Promise<string> {
  const startedAt = Date.now();
  const schema = TOOL_ARG_SCHEMAS[toolName];
  const checked = schema.safeParse(rawArgs ?? {});
  if (!checked.success) {
    const result = "That request was missing something I need — ask the caller to say it again.";
    await logMalikToolCall(client, companyId, {
      toolName,
      args: rawArgs,
      resultText: `ARGUMENTS REJECTED: ${checked.error.issues.map((i) => i.message).join("; ")}`,
      durationMs: Date.now() - startedAt,
      conversationRef: typeof rawArgs.conversation_id === "string" ? rawArgs.conversation_id : null,
    });
    return result;
  }
  let result: string;
  try {
    result = await TOOL_RUNNERS[toolName](client, companyId, checked.data as Record<string, unknown>);
  } catch (err) {
    console.error("[malik] tool failed", toolName, err);
    result = "I couldn't read that right now — the records aren't answering. Say that plainly; don't guess.";
  }
  await logMalikToolCall(client, companyId, {
    toolName,
    args: checked.data as Record<string, unknown>,
    resultText: result,
    durationMs: Date.now() - startedAt,
    conversationRef: typeof rawArgs.conversation_id === "string" ? rawArgs.conversation_id : null,
  });
  return result;
}
