// The native shell's position feed (docs/design/background-tracking.md, Path 2). SERVER ONLY.
// The phone keeps reporting with the app closed; each batch is authenticated by a device token
// (lib/device-token.ts, migration 00073), validated like any external-facing input, and fed through
// the SAME detection as Telegram Live Location (handleLiveLocation): latest position, speed from
// consecutive fixes, movement episodes, the automatic switch to Driving, and the stopped-5-minutes
// proposal. Everything it writes is scoped to the token's company in code (service role).

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashDeviceToken } from "@/lib/device-token";
import type { LiveLocationResult, TelegramLocation } from "@/services/telegram/live-location";

export const MAX_FIXES_PER_BATCH = 60;
export const MAX_FIX_AGE_MS = 24 * 3_600_000;
export const MAX_FUTURE_SKEW_MS = 60_000;

const fixSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.number().min(0).max(100_000).optional(),
  heading_deg: z.number().min(0).max(360).optional(),
  /** Epoch milliseconds, or an ISO string. */
  at: z.union([z.number(), z.string()]),
});
export const feedBodySchema = z.object({ fixes: z.array(fixSchema).min(1).max(MAX_FIXES_PER_BATCH) });

export interface DeviceFix {
  loc: TelegramLocation;
  atMs: number;
}

/** Pure: validated fixes -> time-ordered, with stale/future/unreadable-time fixes dropped (counted, not trusted). */
export function normalizeFixes(
  fixes: z.infer<typeof feedBodySchema>["fixes"],
  nowMs: number,
): { usable: DeviceFix[]; dropped: number } {
  const usable: DeviceFix[] = [];
  let dropped = 0;
  for (const f of fixes) {
    const atMs = typeof f.at === "number" ? f.at : Date.parse(f.at);
    if (!Number.isFinite(atMs) || atMs > nowMs + MAX_FUTURE_SKEW_MS || nowMs - atMs > MAX_FIX_AGE_MS) {
      dropped += 1;
      continue;
    }
    usable.push({
      atMs,
      loc: {
        latitude: f.lat,
        longitude: f.lng,
        ...(f.accuracy_m !== undefined ? { horizontal_accuracy: f.accuracy_m } : {}),
        ...(f.heading_deg !== undefined ? { heading: f.heading_deg } : {}),
      },
    });
  }
  usable.sort((a, b) => a.atMs - b.atMs);
  return { usable, dropped };
}

export interface AuthenticatedDevice {
  tokenId: string;
  companyId: string;
}

/** Looks the token up by its hash; revoked or unknown = null. Marks last_used_at (at most once a minute; best-effort). */
export async function authenticateDeviceToken(client: SupabaseClient, token: string, nowMs: number): Promise<AuthenticatedDevice | null> {
  const { data, error } = await client
    .from("device_tokens")
    .select("id, company_id, last_used_at")
    .eq("token_hash", hashDeviceToken(token))
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; company_id: string; last_used_at: string | null };
  if (!row.last_used_at || nowMs - Date.parse(row.last_used_at) > 60_000) {
    await client.from("device_tokens").update({ last_used_at: new Date(nowMs).toISOString() }).eq("id", row.id).eq("company_id", row.company_id);
  }
  return { tokenId: row.id, companyId: row.company_id };
}

// A simple per-token limiter: the shell batches, so a few requests a minute is normal.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const hits = new Map<string, number[]>();
export function rateLimited(tokenId: string, nowMs: number): boolean {
  const recent = (hits.get(tokenId) ?? []).filter((t) => nowMs - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    hits.set(tokenId, recent);
    return true;
  }
  recent.push(nowMs);
  hits.set(tokenId, recent);
  if (hits.size > 500) hits.clear();
  return false;
}

export type { LiveLocationResult };
