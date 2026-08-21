import { createCrudRoutes } from "@/services/api/crud-routes";
import { createLoadSchema, updateLoadSchema } from "@/data/schemas/loads";
import type { Load } from "@/types/entities";

// filterableFields: ["status"] implements docs/api-contracts.md's
// "loads supports filtering the list endpoint by status".
const routes = createCrudRoutes<Load>(
  "loads",
  { create: createLoadSchema, update: updateLoadSchema },
  { filterableFields: ["status"] },
);

export const GET = routes.list;
export const POST = routes.create;
