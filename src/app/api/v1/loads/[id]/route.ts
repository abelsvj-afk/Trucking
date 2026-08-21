import { createCrudRoutes } from "@/services/api/crud-routes";
import { createLoadSchema, updateLoadSchema } from "@/data/schemas/loads";
import type { Load } from "@/types/entities";

const routes = createCrudRoutes<Load>(
  "loads",
  { create: createLoadSchema, update: updateLoadSchema },
  { filterableFields: ["status"] },
);

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
