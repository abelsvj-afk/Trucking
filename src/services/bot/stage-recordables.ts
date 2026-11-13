// Abel forward-fix (docs/design/driver-mvp.md §11). The bridge
// between the dispatch helper's extraction and the bot's
// propose->yes staging: recordable items spotted in a forwarded or
// pasted dispatch message are validated in code (validateDumpItems -
// the same checker dump intake uses: real write tool, the tool's own
// Zod schema, a verbatim source quote, every number traced to the
// message) and stored as ONE numbered batch in bot_pending_actions.
// Nothing here records anything - execution happens only when the
// owner approves the batch, resolved in code by the agent turn.
//
// ONE rule for which proposal a bare YES answers (telegram audit 2026-11-06, P0-5): the NEWEST one -
// what he was shown last (store-pending targetGroup). A new batch therefore becomes the one awaiting his
// yes (own batch id, item numbers from 1); a proposal that was already waiting stays open and the reply
// names it, so he knows it is still there. (The old "queued behind - settle that one first" wording
// promised the opposite of what a YES actually did.)

import { waitingLine } from "./waiting-list";
import { buildBotTools } from "./tools";
import { parseDispatchTrip, tripToCreateLoadArgs, type ParsedTrip } from "@/lib/dispatch-trip";
import { loadLabel } from "./reference-resolution";
import type { FiledPhotoInfo } from "@/services/telegram/photo-intake";
import { randomUUID } from "node:crypto";
import {
  formatBatchProposal,
  validateDumpItems,
  type RejectedDumpItem,
} from "./dump-intake";
import type { ProposedWrite } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";

export interface StageRecordablesResult {
  proposals: ProposedWrite[];
  rejected: RejectedDumpItem[];
  /** Kept for shape compatibility: staging no longer blocks (see queuedBehindPending). */
  blockedByPending: boolean;
  /** True when a proposal was already waiting when this batch was staged (it stays open; this batch is now the one a YES answers). */
  queuedBehindPending: boolean;
  /** The summary of the proposal that was already waiting, so the reply can name it. */
  earlierPending?: string;
  /** A readable review of a parsed trip assignment (stops, appointments, miles, tasks), when the message was one. */
  review?: string;
  /**
   * D4: the proposal-group keys this staging rendered, in rendered
   * order (batch ids, or the fresh row ids of lone singles) - plus
   * the earlier pending group's key when the reply names it too.
   * The dispatch layer records them against the sent message id,
   * so a quoted YES to the workup reply binds to them.
   */
  stagedGroupKeys: string[];
}

/** The clean review the owner sees before his one yes: everything read, and what is missing. */
export function tripReview(trip: ParsedTrip, brokerResolved: boolean): string {
  const lines = [`NEW TRIP ${trip.tripNumber} — ready for your review`];
  if (trip.brokerName || trip.brokerReference) {
    lines.push(`Broker: ${trip.brokerName ?? "not given"}${brokerResolved ? "" : trip.brokerName ? " (not on file yet — saved without a broker link)" : ""} · Ref: ${trip.brokerReference ?? "not given"}`);
  }
  for (const st of trip.stops) {
    // An unnumbered leg keeps the header dispatch wrote ("LOT TO") so
    // he sees the leg as its own stop, never folded into the one above.
    const headerNote = st.header && !/^STOP\s+\d+/i.test(st.header) ? `${st.header} · ` : "";
    lines.push(
      `Stop ${st.seq} · ${headerNote}${st.kind === "pickup" ? "PICKUP" : st.kind === "delivery" ? "DELIVERY" : "STOP"}: ${st.name ?? "(no name)"}`,
      `  ${st.address ?? "(no address)"}`,
      `  Appointment: ${st.appointmentText ?? "not given"}${st.appointmentAt ? "" : st.appointmentText ? " (zone not recognized — saved as text only, no time set)" : ""}`,
    );
  }
  const mi = (n: number | null) => (n === null ? "not given" : `${n.toLocaleString("en-US", { minimumFractionDigits: 2 })} mi`);
  lines.push(`Miles: deadhead ${mi(trip.deadheadMiles)} · loaded ${mi(trip.loadedMiles)} · total ${mi(trip.totalMiles)}`);
  if (trip.milesMismatch) {
    lines.push(
      `Heads up: the miles don't add up in the message itself (deadhead + loaded = ${mi(trip.milesMismatch.partsSum)}, total printed = ${mi(trip.milesMismatch.printedTotal)}). I kept all three figures exactly as dispatch printed them.`,
    );
  }
  if (trip.warnings.length > 0) {
    lines.push("Check before you say yes:", ...trip.warnings.map((w) => `  ⚠ ${w}`));
  }
  if (trip.tasks.length > 0) lines.push("Requirements:", ...trip.tasks.map((t) => `  • ${t}`));
  return lines.join("\n");
}

/**
 * Telegram fix round (brief fixes 7-9): what arrived WITH the
 * forwarded text in the same burst - photos filed at flush time.
 * Things forwarded together are one package: the attach proposals
 * ride the SAME batch as the load they belong to.
 */
export interface StageBundleContext {
  chatId?: string;
  documents?: FiledPhotoInfo[];
}

export async function stageRecordables(
  store: BotBrainStore,
  userText: string,
  rawItems: unknown,
  bundle?: StageBundleContext,
): Promise<StageRecordablesResult> {
  // A structured trip assignment is read by CODE (lib/dispatch-trip), not by
  // the model: the model path missed origin/destination on exactly this
  // message. Its create_load replaces any create_load the model proposed.
  const trip = parseDispatchTrip(userText);
  const tripArgs = trip ? tripToCreateLoadArgs(trip) : null;
  const modelItems = (Array.isArray(rawItems) ? rawItems : []).filter(
    (item) => !(tripArgs && (item as { tool_name?: unknown } | null)?.tool_name === "create_load"),
  );
  if (!tripArgs && modelItems.length === 0) {
    return { proposals: [], rejected: [], blockedByPending: false, queuedBehindPending: false, stagedGroupKeys: [] };
  }

  const pending = await store.loadPendingAction();
  const queuedBehindPending = pending !== null;

  const writeRegistry = new Map(
    buildBotTools(store)
      .filter((tool) => tool.access === "write")
      .map((tool) => [tool.name, tool] as const),
  );
  const { proposals, rejected } = modelItems.length > 0
    ? validateDumpItems(userText, modelItems, writeRegistry)
    : { proposals: [] as ProposedWrite[], rejected: [] as RejectedDumpItem[] };

  let review: string | undefined;
  if (trip && tripArgs) {
    const brokerId = trip.brokerName ? await findBrokerId(store, trip.brokerName) : null;
    if (brokerId) tripArgs.broker_id = brokerId;
    // Wisdom rule (brief fix 11B-b): a forward naming a trip that is
    // ALREADY on file is not a new load. Identical = say so and stage
    // nothing; different = Abel proposes the correction himself, in
    // one batch (fields via update_load, stops via set_load_stops).
    const existing = await findLoadByTripNumber(store, trip.tripNumber);
    if (existing) {
      review = await stageTripCorrection(store, trip, tripArgs, existing, writeRegistry, proposals);
    } else {
      const createLoad = writeRegistry.get("create_load");
      // One batch for the whole package (brief fix 8): the load,
      // the photo attach(es) forwarded with it, one yes. Trailer
      // linking mutates tripArgs, so it runs BEFORE validation.
      const batchId = randomUUID();
      // Owner 2026-11-12: forwarding the same trip again used to leave BOTH copies waiting, so a later yes
      // could create the load twice. The copy still waiting (and what was bundled with it) is replaced.
      const replaced = await clearWaitingTripCopies(store, trip.tripNumber);
      const bundleLines = await linkBundleTrailer(store, trip, tripArgs, bundle);
      if (replaced > 0) bundleLines.push("This replaces the copy of this trip that was still waiting — there is only one now.");
      const checked = createLoad?.validateArgs ? createLoad.validateArgs(tripArgs) : { ok: true as const, args: tripArgs };
      if (createLoad && checked.ok) {
        proposals.unshift({
          tool: "create_load",
          args: checked.args,
          summary: createLoad.summarize ? createLoad.summarize(checked.args) : "Create load",
          batchId,
          sourceQuote: `NEW TRIP ${trip.tripNumber}`,
          // A parse the cross-check flagged is never staged as
          // high-confidence (brief fix 3) - the warnings ride the review.
          confidence: trip.warnings.length > 0 ? "medium" : "high",
        });
        review = tripReview(trip, Boolean(brokerId));
        bundleLines.push(...stageBundleAttaches(trip, tripArgs, bundle, batchId, proposals));
        if (bundleLines.length > 0) review += `\n${bundleLines.join("\n")}`;
      } else {
        rejected.push({
          summary: `Trip ${trip.tripNumber}`,
          reason: checked.ok ? "create_load is unavailable" : `not saved - ${checked.error}`,
        } as RejectedDumpItem);
      }
    }
    // Thread index (fix 11A): this conversation now owns this trip -
    // by number, by reference, and as its current subject.
    if (bundle?.chatId) {
      await store.upsertThreadEntity({
        chatId: bundle.chatId,
        entityType: "load",
        entityId: existing?.id ?? null,
        keys: [
          { kind: "trip_number", value: trip.tripNumber },
          ...(trip.brokerReference ? [{ kind: "broker_reference", value: trip.brokerReference }] : []),
          { kind: "lane", value: `${String(tripArgs.origin)} → ${String(tripArgs.destination)}` },
        ],
        label: `Trip ${trip.tripNumber}, ${String(tripArgs.origin)} → ${String(tripArgs.destination)}${tripArgs.delivery_date ? `, delivery ${String(tripArgs.delivery_date)}` : ""}`,
        isCurrent: true,
      });
      for (const doc of bundle.documents ?? []) {
        await store.upsertThreadEntity({
          chatId: bundle.chatId,
          entityType: "document",
          entityId: doc.documentId,
          keys: [
            { kind: "file_name", value: doc.fileName },
            ...(doc.identifiers.trailerNumber ? [{ kind: "trailer_number", value: doc.identifiers.trailerNumber }] : []),
            ...(doc.identifiers.pickupNumber ? [{ kind: "pickup_number", value: doc.identifiers.pickupNumber }] : []),
            ...(doc.identifiers.sealNumber ? [{ kind: "seal_number", value: doc.identifiers.sealNumber }] : []),
          ],
          label: `document "${doc.fileName}"`,
        });
      }
    }
  }

  // D4: the groups this staging renders, in order - batch ids for
  // batches, fresh row ids for lone singles (the save reports
  // them, so a quoted YES to the workup reply binds to them).
  const stagedGroupKeys: string[] = [];
  let itemNumber = 0;
  for (const proposal of proposals) {
    itemNumber += 1;
    const key = proposal.batchId ?? randomUUID();
    await store.savePendingAction({
      toolName: proposal.tool,
      args: proposal.args,
      summary: proposal.summary,
      batchId: proposal.batchId,
      itemNumber,
      sourceQuote: proposal.sourceQuote,
      confidence: proposal.confidence,
      ...(proposal.batchId ? {} : { id: key }),
    });
    if (!stagedGroupKeys.includes(key)) stagedGroupKeys.push(key);
  }

  // What was waiting before may just have been replaced by this forward - only name it if it is still open.
  const stillOpen = pending ? (await store.loadOpenPendingRows()).some((r) => r.id === pending.id) : false;
  // D4: the earlier pending proposal is named in the reply too (after the list), so it joins the mapping last.
  if (stillOpen && pending) {
    const earlierKey = pending.batch_id ?? pending.id;
    if (!stagedGroupKeys.includes(earlierKey)) stagedGroupKeys.push(earlierKey);
  }
  return { proposals, rejected, blockedByPending: false, queuedBehindPending: stillOpen, review, earlierPending: stillOpen ? pending?.summary : undefined, stagedGroupKeys };
}

/** Drops waiting create_load proposals for this trip number, with the rest of their batch. Returns how many trips were replaced. */
async function clearWaitingTripCopies(store: BotBrainStore, tripNumber: string): Promise<number> {
  const rows = await store.loadOpenPendingRows();
  const copies = rows.filter((r) => r.tool_name === "create_load" && String(r.arguments.trip_number ?? "") === tripNumber);
  if (copies.length === 0) return 0;
  const batchIds = new Set(copies.map((r) => r.batch_id).filter((b): b is string => Boolean(b)));
  const ids = rows.filter((r) => copies.includes(r) || (r.batch_id && batchIds.has(r.batch_id))).map((r) => r.id);
  await store.clearPendingActions(ids);
  return copies.length;
}

/** Broker NAME -> id, by code (exact, case-insensitive). Ambiguous or missing -> null, never a guess. */
async function findBrokerId(store: BotBrainStore, name: string): Promise<string | null> {
  const { data, error } = await store.client
    .from("brokers")
    .select("id, name")
    .eq("company_id", store.companyId)
    .is("deleted_at", null)
    .ilike("name", name.trim());
  if (error) return null;
  const rows = ((data ?? []) as { id: string; name: string }[]).filter((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  return rows.length === 1 ? rows[0]!.id : null;
}

// ---------------------------------------------------------------------------
// Telegram fix round helpers (fixes 8, 11B-b)
// ---------------------------------------------------------------------------

interface ExistingLoadRow {
  id: string;
  origin: string | null;
  destination: string | null;
  status: string | null;
  pickup_date: string | null;
  delivery_date: string | null;
  trip_number: string | null;
  broker_reference: string | null;
  pickup_window_start?: string | null;
  pickup_window_end?: string | null;
  delivery_window_start?: string | null;
  delivery_window_end?: string | null;
  miles?: number | null;
  loaded_miles?: number | null;
  deadhead_miles?: number | null;
}

async function findLoadByTripNumber(store: BotBrainStore, tripNumber: string): Promise<ExistingLoadRow | null> {
  try {
    const { data } = await store.client
      .from("loads")
      .select("*")
      .eq("company_id", store.companyId)
      .is("deleted_at", null)
      .eq("trip_number", tripNumber)
      .order("created_at", { ascending: false })
      .limit(1);
    return ((data ?? [])[0] as ExistingLoadRow | undefined) ?? null;
  } catch {
    return null;
  }
}

async function findTrailerIdByUnit(store: BotBrainStore, unitNumber: string): Promise<string | null> {
  try {
    const { data } = await store.client
      .from("trailers")
      .select("id")
      .eq("company_id", store.companyId)
      .is("deleted_at", null)
      .ilike("unit_number", unitNumber)
      .limit(2);
    const rows = (data ?? []) as { id: string }[];
    return rows.length === 1 ? rows[0]!.id : null;
  } catch {
    return null;
  }
}

type WriteToolLike = {
  validateArgs?: (args: Record<string, unknown>) => { ok: true; args: Record<string, unknown> } | { ok: false; error: string };
  summarize?: (args: Record<string, unknown>) => string;
  verifyProposal?: (args: Record<string, unknown>) => Promise<{ ok: true; summary?: string } | { ok: false; error: string }>;
};

async function proposalSummary(tool: WriteToolLike, args: Record<string, unknown>, fallback: string): Promise<string> {
  if (tool.summarize) return tool.summarize(args);
  if (tool.verifyProposal) {
    try {
      const verdict = await tool.verifyProposal(args);
      if (verdict.ok && verdict.summary) return verdict.summary;
    } catch {
      /* fall through to the plain-words fallback */
    }
  }
  return fallback;
}

/**
 * Brief fix 11B-b: the forwarded trip is already on file. Identical
 * forward = say so, stage nothing. Different = ONE correction batch
 * (update_load for changed fields + set_load_stops for the stops),
 * rendered in words against what's on file now.
 */
async function stageTripCorrection(
  store: BotBrainStore,
  trip: ParsedTrip,
  tripArgs: Record<string, unknown>,
  existing: ExistingLoadRow,
  writeRegistry: Map<string, WriteToolLike>,
  proposals: ProposedWrite[],
): Promise<string> {
  const { data: stopRows } = await store.client
    .from("load_stops")
    .select("seq, kind, name, appointment_at")
    .eq("load_id", existing.id)
    .order("seq", { ascending: true });
  const existingStops = (stopRows ?? []) as { seq: number; kind: string; name: string; appointment_at: string | null }[];
  const sig = (kind: string, name: string, at: string | null | undefined) => `${kind}|${name}|${at ?? ""}`;
  const existingSig = existingStops.map((s) => sig(s.kind, s.name, s.appointment_at)).join(";");
  const newStops = (tripArgs.stops ?? []) as { kind: string; name: string; appointment_at?: string | null }[];
  const newSig = newStops.map((s) => sig(s.kind, s.name, s.appointment_at ?? null)).join(";");

  const headlineFields = [
    "origin", "destination", "pickup_date", "delivery_date",
    "pickup_window_start", "pickup_window_end", "delivery_window_start", "delivery_window_end",
    "miles", "loaded_miles", "deadhead_miles", "broker_reference",
  ] as const;
  const changedArgs: Record<string, unknown> = { load_id: existing.id };
  for (const field of headlineFields) {
    const value = tripArgs[field];
    if (value === undefined || value === null) continue;
    if (String(value) !== String(existing[field] ?? "")) changedArgs[field] = value;
  }
  const stopsChanged = existingSig !== newSig;
  const fieldsChanged = Object.keys(changedArgs).length > 1;

  if (!stopsChanged && !fieldsChanged) {
    return `${tripReview(trip, false)}\n\nGood news: Trip ${trip.tripNumber} is already on file exactly like this — I didn't stage a duplicate.`;
  }

  const batchId = randomUUID();
  const updateTool = writeRegistry.get("update_load");
  if (fieldsChanged && updateTool) {
    const checked = updateTool.validateArgs ? updateTool.validateArgs(changedArgs) : { ok: true as const, args: changedArgs };
    if (checked.ok) {
      proposals.unshift({
        tool: "update_load",
        args: checked.args,
        summary: await proposalSummary(updateTool, checked.args, `Update Trip ${trip.tripNumber}`),
        batchId,
        sourceQuote: `CORRECTED TRIP ${trip.tripNumber}`,
        confidence: "high",
      });
    }
  }
  const stopsTool = writeRegistry.get("set_load_stops");
  if (stopsChanged && stopsTool) {
    const stopsArgs = { load_id: existing.id, stops: newStops };
    const checked = stopsTool.validateArgs ? stopsTool.validateArgs(stopsArgs) : { ok: true as const, args: stopsArgs };
    if (checked.ok) {
      proposals.push({
        tool: "set_load_stops",
        args: checked.args,
        summary: await proposalSummary(stopsTool, checked.args, `Replace the stops on Trip ${trip.tripNumber}`),
        batchId,
        sourceQuote: `CORRECTED TRIP ${trip.tripNumber}`,
        confidence: "high",
      });
    }
  }

  return [
    `CORRECTED TRIP ${trip.tripNumber} — this dispatch does not match what is on file.`,
    `On file now: ${loadLabel(existing)} (${existingStops.length} stop${existingStops.length === 1 ? "" : "s"}).`,
    `This message says: ${String(tripArgs.origin)} → ${String(tripArgs.destination)}, delivery ${String(tripArgs.delivery_date ?? "?")}, with ${newStops.length} stops.`,
    "I staged ONE correction covering the load and all its stops — nothing changes until your yes. Check the stops below against the dispatch before you approve.",
    tripReview(trip, false),
  ].join("\n");
}

/**
 * Brief fix 8: a photo forwarded WITH the trip names a trailer that
 * is on file - it rides on the create itself. Returns review lines.
 */
async function linkBundleTrailer(
  store: BotBrainStore,
  trip: ParsedTrip,
  tripArgs: Record<string, unknown>,
  bundle: StageBundleContext | undefined,
): Promise<string[]> {
  const lines: string[] = [];
  for (const doc of bundle?.documents ?? []) {
    const trailerNo = doc.identifiers.trailerNumber;
    if (!trailerNo) continue;
    const trailerId = await findTrailerIdByUnit(store, trailerNo);
    if (trailerId) {
      tripArgs.trailer_id = trailerId;
      lines.push(`Trailer ${trailerNo} is on file — it rides on this load (Trip ${trip.tripNumber}) in the same yes.`);
    } else {
      lines.push(`The photo shows trailer ${trailerNo} — no trailer with that number is on file, so I didn't link one.`);
    }
  }
  return lines;
}

/**
 * Brief fixes 7-8: every photo forwarded with the trip stages an
 * attach to the load being created, in the SAME batch. The tool
 * resolves the trip number to the just-created load at run time.
 */
function stageBundleAttaches(
  trip: ParsedTrip,
  tripArgs: Record<string, unknown>,
  bundle: StageBundleContext | undefined,
  batchId: string,
  proposals: ProposedWrite[],
): string[] {
  const lines: string[] = [];
  for (const doc of bundle?.documents ?? []) {
    proposals.push({
      tool: "attach_document",
      args: { document_id: doc.documentId, related_entity_type: "load", related_trip_number: trip.tripNumber },
      summary: `Attach "${doc.fileName}" to Trip ${trip.tripNumber} (${String(tripArgs.origin)} → ${String(tripArgs.destination)})`,
      batchId,
      sourceQuote: "forwarded with the trip",
      confidence: "high",
    });
    const readBits = [
      doc.identifiers.trailerNumber ? `trailer ${doc.identifiers.trailerNumber}` : null,
      doc.identifiers.pickupNumber ? `pickup #${doc.identifiers.pickupNumber}` : null,
      doc.identifiers.sealNumber ? `seal ${doc.identifiers.sealNumber}` : null,
    ].filter(Boolean);
    lines.push(
      `"${doc.fileName}" is attached to this load in the same yes${readBits.length > 0 ? ` — I read ${readBits.join(", ")} from it` : ""}.`,
    );
  }
  return lines;
}

/**
 * The reply suffix for a staging outcome, shared by every dispatch
 * surface so the owner hears the same words everywhere: the batch
 * proposal (when items staged), the queued note (when a proposal
 * was already waiting - the batch is filed behind it, NOT yet
 * awaiting his yes, so no YES grammar is shown for it), or the
 * named rejections (never silent).
 */
export function formatRecordableOutcome(result: StageRecordablesResult): string {
  let out = result.review ? `\n\n${result.review}` : "";
  if (result.proposals.length > 0) {
    out += formatBatchProposal(
      result.proposals.map((p) => ({
        summary: p.summary,
        sourceQuote: p.sourceQuote,
        confidence: p.confidence,
      })),
    );
  }
  if (result.queuedBehindPending && result.proposals.length > 0 && result.earlierPending) {
    out +=
      `\n\n(A YES now answers the list above. Something from before is also still waiting: ${waitingLine(result.earlierPending)} — ` +
      "tell me in words if you want that one recorded or dropped.)";
  }
  for (const rejection of result.rejected) {
    out += `\n\nNot staged: ${rejection.summary} - ${rejection.reason}`;
  }
  return out;
}
