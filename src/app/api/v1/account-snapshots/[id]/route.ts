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

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
