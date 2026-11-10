// A geocoder that remembers (migration 00089): look in geocode_cache first, ask the real provider only on a miss, store the answer -
// including "not found", so a bad address is not asked about on every request. A recorded miss is tried again after MISS_RETRY_MS.
// Before 00089 is applied (table absent) it degrades to the wrapped provider and says nothing: correctness is unchanged, only the
// saving is lost. A provider outage is never cached.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LatLng } from "@/lib/smart-path";
import type { GeocodingProvider } from "@/services/integrations/geocoding";

export const MISS_RETRY_MS = 7 * 24 * 3_600_000;

export const normalizeQuery = (query: string): string => query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500);

export function createCachedGeocoder(client: SupabaseClient, companyId: string, inner: GeocodingProvider, now: () => Date = () => new Date()): GeocodingProvider {
  return {
    name: `${inner.name} (cached)`,
    async geocode(query: string): Promise<LatLng | null> {
      const key = normalizeQuery(query);
      if (!key) return null;
      let tableUsable = true;
      try {
        const { data, error } = await client.from("geocode_cache").select("lat, lng, geocoded_at").eq("company_id", companyId).eq("query", key).maybeSingle();
        if (error) tableUsable = false;
        else if (data) {
          const row = data as { lat: number | null; lng: number | null; geocoded_at: string };
          if (row.lat !== null && row.lng !== null) return { lat: row.lat, lng: row.lng };
          if (now().getTime() - Date.parse(row.geocoded_at) < MISS_RETRY_MS) return null;
        }
      } catch {
        tableUsable = false;
      }
      const result = await inner.geocode(query); // an outage throws from here and is NOT cached
      if (tableUsable) {
        try {
          await client
            .from("geocode_cache")
            .upsert({ company_id: companyId, query: key, lat: result?.lat ?? null, lng: result?.lng ?? null, provider: inner.name, geocoded_at: now().toISOString() }, { onConflict: "company_id,query" });
        } catch {
          /* the cache is a saving, never a requirement */
        }
      }
      return result;
    },
  };
}
