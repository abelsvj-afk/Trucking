import { createCrudRoutes } from "@/services/api/crud-routes";
import { createFuelPurchaseSchema, updateFuelPurchaseSchema } from "@/data/schemas/fuel-purchases";
import { prepareFuelCreate } from "@/services/api/fuel-write";
import type { FuelPurchase } from "@/types/entities";

const routes = createCrudRoutes<FuelPurchase>("fuel_purchases", {
  create: createFuelPurchaseSchema,
  update: updateFuelPurchaseSchema,
}, {
  // Unit C (D-04): the total is derived on every create (fuel-write.ts).
  prepareCreate: prepareFuelCreate,
});

export const GET = routes.list;
export const POST = routes.create;
