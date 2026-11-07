// No redundant approvals (owner 2026-11-07: Abel "needs to realize when it has two redundant things it's trying
// to get me to approve"; design docs/design/bot-messages-and-safety.md section 3). Pure: given the proposals Abel
// is about to stage and the ones already waiting, decide what is staged, what is replaced, and what is dropped.
//  - identical to one already waiting (or to another in the same turn) -> not staged again;
//  - same target, different values -> within one turn the changes are MERGED (later values win); against a waiting
//    single proposal the OLDER one is replaced by the newer;
//  - different targets, and creates of new things -> untouched.

export interface Proposal {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  batchId?: string;
}

export interface WaitingRow {
  id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  summary: string;
  batch_id: string | null;
}

/** Tools whose proposals are about ONE existing thing, so two of them can be merged or replaced. */
const TARGETED = /^(?:update_|complete_load$|set_pay_terms$|set_pay_pin$|delete_record$|attach_document$|mark_thread_answered$)/;

const stripNoise = (args: Record<string, unknown>) => {
  const { confirmation: _confirmation, ...rest } = args;
  void _confirmation;
  return rest;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sameArgs = (a: Record<string, unknown>, b: Record<string, unknown>) => stable(stripNoise(a)) === stable(stripNoise(b));

/** What this proposal is ABOUT (tool + the record/employer it targets), or null when it is a free-standing create. */
export function targetKey(tool: string, args: Record<string, unknown>): string | null {
  if (!TARGETED.test(tool)) return null;
  if (tool === "set_pay_terms") return `set_pay_terms:${String(args.employer_name ?? "").trim().toLowerCase()}`;
  if (tool === "set_pay_pin") return "set_pay_pin";
  if (tool === "delete_record") return `delete_record:${String(args.entity ?? "")}:${String(args.record_id ?? "")}`;
  const idKey = Object.keys(args).find((k) => k.endsWith("_id") && typeof args[k] === "string");
  return idKey ? `${tool}:${String(args[idKey])}` : null;
}

export interface Reconciled<T extends Proposal = Proposal> {
  /** Proposals to stage now (merged where two touched the same thing). */
  stage: T[];
  /** Merged proposals whose summary the caller must rebuild from the merged args. */
  mergedTools: string[];
  /** Waiting single proposals that this turn's newer proposal replaces. */
  clearIds: string[];
  /** Plain-words notes for the reply. */
  notes: string[];
  /** Summaries of waiting proposals that an identical new one was dropped in favour of. */
  alreadyWaiting: string[];
}

export function reconcileProposals<T extends Proposal>(incoming: T[], waiting: WaitingRow[]): Reconciled<T> {
  const notes: string[] = [];
  const alreadyWaiting: string[] = [];
  const mergedTools: string[] = [];

  // 1. within this turn: drop identical repeats, merge changes to the same target (later values win).
  const turn: T[] = [];
  for (const p of incoming) {
    const twin = turn.find((q) => q.tool === p.tool && !q.batchId && !p.batchId && sameArgs(q.args, p.args));
    if (twin) {
      notes.push("I asked for the same thing twice, so I listed it once.");
      continue;
    }
    const key = p.batchId ? null : targetKey(p.tool, p.args);
    const same = key ? turn.find((q) => !q.batchId && targetKey(q.tool, q.args) === key) : undefined;
    if (same && !p.tool.startsWith("delete_record")) {
      same.args = { ...same.args, ...p.args };
      same.summary = p.summary; // rebuilt from the merged args by the caller
      mergedTools.push(same.tool);
      notes.push("I combined two changes to the same thing into one.");
      continue;
    }
    turn.push({ ...p });
  }

  // 2. against what is already waiting for his yes.
  const clearIds: string[] = [];
  const stage: T[] = [];
  for (const p of turn) {
    const identical = waiting.find((w) => w.tool_name === p.tool && sameArgs(w.arguments, p.args));
    if (identical) {
      alreadyWaiting.push(identical.summary);
      notes.push("That was already waiting for your yes, so I didn't list it again.");
      continue;
    }
    const key = p.batchId ? null : targetKey(p.tool, p.args);
    if (key) {
      // Only SINGLE waiting proposals are replaced; a batch item keeps its number.
      const older = waiting.filter((w) => !w.batch_id && w.tool_name === p.tool && targetKey(w.tool_name, w.arguments) === key);
      for (const w of older) {
        clearIds.push(w.id);
        notes.push(`This replaces the earlier request still waiting: ${w.summary}`);
      }
    }
    stage.push(p);
  }

  return { stage, mergedTools, clearIds, notes: [...new Set(notes)], alreadyWaiting };
}
