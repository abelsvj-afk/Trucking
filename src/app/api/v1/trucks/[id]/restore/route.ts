import { createCrudRoutes } from "@/services/api/crud-routes";
import { createTruckSchema, updateTruckSchema } from "@/data/schemas/trucks";
import type { Truck } from "@/types/entities";

const routes = createCrudRoutes<Truck>("trucks", {
  create: createTruckSchema,
  update: updateTruckSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
