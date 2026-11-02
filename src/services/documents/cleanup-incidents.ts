// Cleanup incidents (Reliability Unit A / F-038 record shape, design
// A.7): a storage object with no owning documents row is an obligation,
// not a shrug. When a compensating removal fails, the failure is
// RECORDED here so the Documents page can surface it with a retry -
// the alternative (a comment promising the files are "removed",
// unchecked) is how orphans accumulated silently before.
//
// Recording is best-effort BY DESIGN: it runs on failure paths where
// throwing again would mask the original error. A failed insert is
// logged to the server log; the caller's error still says cleanup may
// have failed, which is the honest surface either way.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CleanupIncidentInput {
  companyId: string | null;
  storagePath: string;
  kind: "upload_rollback" | "row_insert_failed";
  detail: string;
}

export async function recordCleanupIncident(
  client: SupabaseClient,
  input: CleanupIncidentInput,
): Promise<boolean> {
  const { error } = await client.from("cleanup_incidents").insert({
    company_id: input.companyId,
    storage_path: input.storagePath,
    kind: input.kind,
    status: "open",
    detail: input.detail,
  });
  if (error) {
    console.error(
      `cleanup incident recording failed for ${input.storagePath}: ${error.message}`,
    );
    return false;
  }
  return true;
}
