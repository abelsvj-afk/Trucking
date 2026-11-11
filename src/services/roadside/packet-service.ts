// Roadside packet service (docs/design/eld-roadside-overlay.md): assembles
// the inspection packet from the ONE HOS read, files it (roadside_packets
// row + a documents row in the documents bucket), and records where it
// went. Every surface - the /roadside page, the Abel tools, the officer
// email - goes through here, so the packet an officer sees is the packet
// on file, byte for byte.
//
// Filing note: the shared document pipeline (store-document.ts) enforces a
// PDF/image allowlist for USER paperwork. The packet is app-generated
// plain text, so this service stores it through the same bucket and table
// directly, with the same cleanup rule (a failed row insert removes the
// uploaded object). The documents build (build #3) can fold text files
// into the shared pipeline when it lands.

import type { SupabaseClient } from "@supabase/supabase-js";
import { cycleLine, loadHosWindow, toWindowSummary } from "@/services/api/hos-window";
import { computeHudClocks } from "@/lib/hud-clocks";
import { buildRoadsidePacket, type RoadsidePacket } from "@/lib/roadside-packet";
import { fetchEditedDutyLogIds } from "@/services/duty-log-edits";

const BUCKET = "documents";

/** Builds the packet from the live HOS read. Throws only on a failed read. */
export async function buildLivePacket(client: SupabaseClient, companyId: string, now: Date = new Date()): Promise<RoadsidePacket> {
  const snapshot = await loadHosWindow(client, companyId);
  const summary = toWindowSummary(snapshot);
  const clocks = computeHudClocks(snapshot.rows, summary, now.getTime());

  let companyName: string | null = null;
  let driverName: string | null = null;
  try {
    const { data: company } = await client.from("companies").select("name").eq("id", companyId).is("deleted_at", null).maybeSingle();
    companyName = (company as { name?: string } | null)?.name ?? null;
  } catch { /* the packet still builds; the header says the name isn't recorded */ }
  try {
    const { data: drivers } = await client
      .from("drivers")
      .select("name, role, created_at")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(20);
    const list = (drivers ?? []) as { name: string; role: string | null }[];
    driverName = (list.find((d) => d.role === "owner_operator") ?? list[0])?.name ?? null;
  } catch { /* same graceful absence */ }

  // Edit trail (spec §2.2): ONE extra read keyed by the window's entry
  // ids - which entries carry a trail row - so the packet can mark
  // each edited entry "Edited - original retained in the app". The
  // HOS read itself is untouched; on a database without the trail
  // table this reads as "no edits" and the packet is unchanged.
  const editedEntryIds = await fetchEditedDutyLogIds(
    client,
    snapshot.rows.map((row) => row.id),
  );

  return buildRoadsidePacket({
    driverName,
    companyName,
    rows: snapshot.rows,
    clocks,
    cycleLine: cycleLine(snapshot),
    now,
    editedEntryIds,
  });
}

export interface FiledPacket {
  packetId: string;
  documentId: string | null;
}

/**
 * Files the packet: roadside_packets row (the audit copy) + the packet
 * file in the documents bucket with its documents row. Throws an Error
 * with a plain message on failure - pre-migration-00086 databases land
 * here too, and callers translate it honestly ("the database step isn't
 * in yet") instead of pretending the packet was filed.
 */
export async function filePacket(client: SupabaseClient, companyId: string, packet: RoadsidePacket): Promise<FiledPacket> {
  const { data: row, error: rowError } = await client
    .from("roadside_packets")
    .insert({ company_id: companyId, period_start: packet.periodStart, period_end: packet.periodEnd, body: packet.text })
    .select("id")
    .single();
  if (rowError || !row) throw new Error(`roadside packet row failed: ${rowError?.message ?? "no row returned"}`);
  const packetId = String((row as { id: string }).id);

  const storagePath = `${companyId}/${packetId}-${packet.fileName}`;
  const blob = new Blob([packet.text], { type: "text/plain" });
  const { error: uploadError } = await client.storage.from(BUCKET).upload(storagePath, blob, { contentType: "text/plain", upsert: false });
  if (uploadError) {
    await client.from("roadside_packets").delete().eq("company_id", companyId).eq("id", packetId);
    throw new Error(`roadside packet upload failed: ${uploadError.message}`);
  }
  const { data: doc, error: docError } = await client
    .from("documents")
    .insert({
      company_id: companyId,
      file_name: packet.fileName,
      content_type: "text/plain",
      storage_path: storagePath,
      related_entity_type: "roadside_packet",
      related_entity_id: packetId,
    })
    .select("id")
    .single();
  if (docError || !doc) {
    await client.storage.from(BUCKET).remove([storagePath]);
    await client.from("roadside_packets").delete().eq("company_id", companyId).eq("id", packetId);
    throw new Error(`roadside packet document row failed: ${docError?.message ?? "no row returned"}`);
  }
  const documentId = String((doc as { id: string }).id);
  await client.from("roadside_packets").update({ document_id: documentId }).eq("company_id", companyId).eq("id", packetId);
  return { packetId, documentId };
}

/** The most recent filed packet, or null. Used by the Telegram "send it to me" path so he gets the exact filed bytes. */
export async function latestFiledPacket(client: SupabaseClient, companyId: string): Promise<{ id: string; packet: RoadsidePacket } | null> {
  const { data, error } = await client
    .from("roadside_packets")
    .select("id, body, period_start, period_end")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as { id: string; body: string; period_start: string; period_end: string };
  return {
    id: r.id,
    packet: {
      subject: "",
      text: r.body,
      fileName: `inspection-packet-${r.period_end}.txt`,
      periodStart: r.period_start,
      periodEnd: r.period_end,
    },
  };
}

export async function markPacketEmailed(client: SupabaseClient, companyId: string, packetId: string, to: string, emailSentId: string | null): Promise<void> {
  await client
    .from("roadside_packets")
    .update({ sent_to: to, email_sent_id: emailSentId, sent_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("id", packetId);
}

export async function markPacketTelegrammed(client: SupabaseClient, companyId: string, packetId: string): Promise<void> {
  await client.from("roadside_packets").update({ telegram_sent_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", packetId);
}
