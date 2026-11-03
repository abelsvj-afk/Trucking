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

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
