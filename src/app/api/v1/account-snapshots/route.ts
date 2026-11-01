// Manual account snapshots (docs/design/driver-mvp.md §9.5) - the v1
// implementation behind the account-visibility seam. Standard CRUD;
// the Truck Fund tab reads them through the seam
// (services/fund/account-visibility.ts), which adds source and
// staleness labeling.

import { createCrudRoutes } from "@/services/api/crud-routes";
import {
  createAccountSnapshotSchema,
  updateAccountSnapshotSchema,
} from "@/data/schemas/account-snapshots";
import type { AccountSnapshot } from "@/types/entities";

const routes = createCrudRoutes<AccountSnapshot>("account_snapshots", {
  create: createAccountSnapshotSchema,
  update: updateAccountSnapshotSchema,
});

export const GET = routes.list;
export const POST = routes.create;
