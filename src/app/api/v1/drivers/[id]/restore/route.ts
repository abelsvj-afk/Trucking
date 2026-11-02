import { createCrudRoutes } from "@/services/api/crud-routes";
import { createDriverSchema, updateDriverSchema } from "@/data/schemas/drivers";
import type { Driver } from "@/types/entities";

const routes = createCrudRoutes<Driver>("drivers", {
  create: createDriverSchema,
  update: updateDriverSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
