// Agent omnipresence (docs/design/driver-mvp.md §9). Dump intake:
// the code half of turning a dumped message (a forwarded dispatch
// thread, a pasted rate con, a brain-dump paragraph) into ONE
// consolidated, numbered batch proposal.
//
// The model does the extraction; this module does the checking.
// Nothing here trusts the extraction:
// - every item must name a real write tool and pass that tool's own
//   Zod validation (via the tool's validateArgs);
// - every item must carry a source_quote that is a verbatim span of
//   the owner's message;
// - every number in an item's values (amounts, gate codes, counts)
//   must appear in the owner's message - a value that appears
//   nowhere is rejected, named, and never staged. Ids and dates are
//   exempt from the number check: ids come from his records (read
//   tools), and dates are derived from words like "Tuesday" (their
//   source_quote must still mention a day or a date).
// Accepted items become ProposedWrites sharing one batch id; the
// caller stores them as bot_pending_actions rows (migration 00021)
// and the owner's batch replies are parsed here, in code.

import { randomUUID } from "node:crypto";
import type { AgentTool, ProposedWrite } from "@/services/ai/agent-loop";

export interface DumpItemInput {
  tool_name: string;
  args: Record<string, unknown>;
  source_quote: string;
  confidence: "high" | "medium" | "low";
}

export interface RejectedDumpItem {
  summary: string;
  reason: string;
}

export interface DumpValidationResult {
  proposals: ProposedWrite[];
  rejected: RejectedDumpItem[];
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Canonical numeric tokens in a text: "1,200" -> "1200", "$5.890" -> "5.89". */
function numericTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/\d[\d,]*\.?\d*/g)) {
    const value = Number.parseFloat(match[0].replace(/,/g, ""));
    if (Number.isFinite(value)) tokens.add(canonicalNumber(value));
  }
  return tokens;
}

function canonicalNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/**
 * Numbers an item's values claim, which must all trace to the dump
 * text. Walks the validated args recursively. Skips: *_id keys and
 * uuid values (they come from his records, via read tools), date /
 * timestamp keys and values (derived from day words - checked
 * separately through the source quote), and booleans.
 */
function claimedNumbers(args: Record<string, unknown>): string[] {
  const claimed: string[] = [];
  const walk = (key: string, value: unknown): void => {
    if (value === null || value === undefined) return;
    if (key.endsWith("_id") || key === "id") return;
    if (key.endsWith("_date") || key.endsWith("_at")) return;
    if (typeof value === "number") {
      if (Number.isFinite(value)) claimed.push(canonicalNumber(value));
      return;
    }
    if (typeof value === "string") {
      if (UUID_PATTERN.test(value) || ISO_DATE_PATTERN.test(value)) return;
      for (const token of numericTokens(value)) claimed.push(token);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(key, entry);
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(k, v);
    }
  };
  for (const [k, v] of Object.entries(args)) walk(k, v);
  return claimed;
}

/** True when the item sets a date/timestamp field (so its quote must mention a day or a date). */
function setsDateField(args: Record<string, unknown>): boolean {
  return Object.entries(args).some(
    ([k, v]) =>
      (k.endsWith("_date") || k.endsWith("_at")) && typeof v === "string" && ISO_DATE_PATTERN.test(v),
  );
}

const DAY_OR_DATE_PATTERN =
  /\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun|today|tomorrow|tonight/i;

export function validateDumpItems(
  userText: string,
  rawItems: unknown,
  writeTools: Map<string, AgentTool>,
): DumpValidationResult {
  const proposals: ProposedWrite[] = [];
  const rejected: RejectedDumpItem[] = [];
  const batchId = randomUUID();
  const textTokens = numericTokens(userText);
  const normalizedText = normalizeText(userText);

  if (!Array.isArray(rawItems)) {
    return {
      proposals,
      rejected: [{ summary: "the whole dump", reason: "items was not a list - nothing was staged" }],
    };
  }

  rawItems.forEach((raw, index) => {
    const label = `item ${index + 1}`;
    const item = raw as Partial<DumpItemInput> | null;
    if (!item || typeof item !== "object" || typeof item.tool_name !== "string") {
      rejected.push({ summary: label, reason: "it did not name a tool to record with" });
      return;
    }
    const tool = writeTools.get(item.tool_name);
    if (!tool || tool.access !== "write") {
      rejected.push({
        summary: `${label} (${item.tool_name})`,
        reason: `"${item.tool_name}" is not a recordable write action`,
      });
      return;
    }
    if (tool.alwaysPropose) {
      rejected.push({
        summary: `${label} (${item.tool_name})`,
        reason: "that action always needs its own separate yes - it cannot ride in a dump batch",
      });
      return;
    }
    if (!tool.validateArgs || !tool.summarize) {
      rejected.push({
        summary: `${label} (${item.tool_name})`,
        reason: "that action cannot be staged from a dump",
      });
      return;
    }
    const validation = tool.validateArgs(
      item.args && typeof item.args === "object" ? item.args : {},
    );
    if (!validation.ok) {
      rejected.push({ summary: `${label} (${item.tool_name})`, reason: validation.error });
      return;
    }
    const args = validation.args;

    const quote = typeof item.source_quote === "string" ? item.source_quote : "";
    if (!quote || !normalizedText.includes(normalizeText(quote))) {
      rejected.push({
        summary: `${label} (${item.tool_name})`,
        reason: "its source quote is not a verbatim part of his message",
      });
      return;
    }

    const ungrounded = claimedNumbers(args).filter((n) => !textTokens.has(n));
    if (ungrounded.length > 0) {
      rejected.push({
        summary: `${label} (${item.tool_name})`,
        reason: `the value ${ungrounded.join(", ")} appears nowhere in his message - extraction is not allowed to invent figures`,
      });
      return;
    }

    if (setsDateField(args) && !DAY_OR_DATE_PATTERN.test(quote)) {
      rejected.push({
        summary: `${label} (${item.tool_name})`,
        reason: "it sets a date but its source quote mentions no day or date to derive it from",
      });
      return;
    }

    const confidence =
      item.confidence === "high" || item.confidence === "medium" || item.confidence === "low"
        ? item.confidence
        : "low";

    let summary: string;
    try {
      summary = tool.summarize(args);
    } catch (err) {
      rejected.push({
        summary: `${label} (${item.tool_name})`,
        reason: err instanceof Error ? err.message : "could not summarize the item",
      });
      return;
    }

    proposals.push({
      tool: item.tool_name,
      args,
      summary,
      batchId,
      sourceQuote: quote,
      confidence,
    });
  });

  return { proposals, rejected };
}

/** One numbered batch line, the shape the owner approves or corrects by number. */
export function formatBatchItemLine(
  itemNumber: number,
  item: { summary: string; sourceQuote?: string | null; confidence?: string | null },
): string {
  const parts = [`${itemNumber}. ${item.summary}`];
  if (item.confidence) parts.push(`(confidence: ${item.confidence})`);
  if (item.sourceQuote) parts.push(`— from: "${item.sourceQuote}"`);
  return parts.join(" ");
}

export function formatBatchProposal(
  items: { summary: string; sourceQuote?: string | null; confidence?: string | null }[],
): string {
  const lines = items.map((item, i) => formatBatchItemLine(i + 1, item));
  return (
    `\n\nI have NOT recorded any of this yet. Here's what I pulled from that:\n${lines.join("\n")}\n\n` +
    "Reply YES to record all of it, name the numbers to record only those (e.g. \"approve 1, 3\"), " +
    "tell me a correction (e.g. \"3 is wrong, it's 4417\"), or say NO to drop it all."
  );
}

export type BatchCommand =
  | { kind: "approve_all" }
  | { kind: "drop_all" }
  | { kind: "approve_some"; numbers: number[] }
  | { kind: "drop_rest" }
  | { kind: "other" };

const BATCH_YES_WORDS = new Set(["yes", "yeah", "yep", "yup", "ok", "okay", "sure", "confirm", "sí", "si", "dale"]);
const BATCH_NO_WORDS = new Set(["no", "nope", "cancel", "don't", "dont", "never mind", "nevermind", "forget it", "no thanks"]);

/**
 * Parses the owner's reply to a pending batch, in code (§9):
 * a plain yes approves all; a numbered list approves exactly
 * those; "drop the rest" clears what remains; a plain no drops
 * all. Anything else (notably corrections) is "other" and goes to
 * the model with the batch in context.
 */
export function parseBatchCommand(text: string): BatchCommand {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, "");

  if (
    /^(drop|forget|cancel|skip) the rest/.test(normalized) ||
    normalized === "that's all" ||
    normalized === "thats all" ||
    normalized === "the rest no"
  ) {
    return { kind: "drop_rest" };
  }

  const selective = normalized.match(
    /^(?:approve|record|keep|do|yes to|just|only|yes)\s+([\d][\d,\s]*(?:and\s+[\d][\d,\s]*)*)$/,
  );
  const bareNumbers = normalized.match(/^([\d][\d,\s]*(?:and\s+[\d][\d,\s]*)*)$/);
  const numberList = selective?.[1] ?? bareNumbers?.[1];
  if (numberList) {
    const numbers = [...new Set(numberList.match(/\d+/g)!.map((n) => Number.parseInt(n, 10)))];
    if (numbers.length > 0) return { kind: "approve_some", numbers };
  }

  if (
    BATCH_YES_WORDS.has(normalized) ||
    normalized.startsWith("yes ") ||
    normalized === "approve all" ||
    normalized === "do all" ||
    normalized === "all" ||
    normalized === "everything"
  ) {
    return { kind: "approve_all" };
  }
  if (BATCH_NO_WORDS.has(normalized) || normalized.startsWith("no ") || normalized === "drop it") {
    return { kind: "drop_all" };
  }
  return { kind: "other" };
}
