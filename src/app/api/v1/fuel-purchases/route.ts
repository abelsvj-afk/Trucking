import { createCrudRoutes } from "@/services/api/crud-routes";
import { createFuelPurchaseSchema, updateFuelPurchaseSchema } from "@/data/schemas/fuel-purchases";
import type { FuelPurchase } from "@/types/entities";

const routes = createCrudRoutes<FuelPurchase>("fuel_purchases", {
  create: createFuelPurchaseSchema,
  update: updateFuelPurchaseSchema,
});

export const GET = routes.list;
export const POST = routes.create;
