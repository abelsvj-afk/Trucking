// Account visibility seam (docs/design/driver-mvp.md §9.5). The Truck
// Fund tab reads accounts ONLY through this interface, shaped the way
// a normalized Plaid /accounts response would look (institution,
// name, last-4 mask, balance, as-of) plus a `source` tag saying where
// the data actually came from.
//
// v1's implementation is manual snapshots: real balances the owner
// (or King) recorded by hand, true as of their date, labeled with
// that date and a staleness level - never presented as a live sync.
// A live Plaid implementation drops in behind this same interface
// when its prerequisites exist (his own Plaid developer account,
// PLAID_CLIENT_ID / PLAID_SECRET as Fly secrets, the Link flow -
// §9.5 lists them all). Nothing in this file calls Plaid: the Plaid
// access in King's chat environment is a connector pipe the hosted
// app cannot use, and wiring the UI to it would be fake.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createCrudService } from "@/services/db/crud";
import { snapshotStaleness } from "@/lib/truck-fund";
import type { AccountSnapshot } from "@/types/entities";
import type { AccountView } from "@/types/truck-fund";

export interface AccountVisibilityProvider {
  listAccounts(supabase: SupabaseClient, today: string): Promise<AccountView[]>;
}

const snapshots = createCrudService<AccountSnapshot>("account_snapshots");

export const manualSnapshotAccountVisibility: AccountVisibilityProvider = {
  async listAccounts(supabase, today) {
    const result = await snapshots.list(supabase, { limit: 50, offset: 0 });
    return result.data.map((row) => {
      const staleness = snapshotStaleness(row.as_of_date, today);
      return {
        ...row,
        source: "manual_snapshot" as const,
        staleness: { level: staleness.level, age_days: staleness.ageDays, label: staleness.label },
      };
    });
  },
};
