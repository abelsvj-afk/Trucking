import { createCrudRoutes } from "@/services/api/crud-routes";
import { createFuelPurchaseSchema, updateFuelPurchaseSchema } from "@/data/schemas/fuel-purchases";
import type { FuelPurchase } from "@/types/entities";

const routes = createCrudRoutes<FuelPurchase>("fuel_purchases", {
  create: createFuelPurchaseSchema,
  update: updateFuelPurchaseSchema,
});

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
