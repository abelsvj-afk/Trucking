import { createCrudRoutes } from "@/services/api/crud-routes";
import { createLoadStopSchema, updateLoadStopSchema } from "@/data/schemas/load-stops";
import type { LoadStop } from "@/types/entities";

const routes = createCrudRoutes<LoadStop>(
  "load_stops",
  { create: createLoadStopSchema, update: updateLoadStopSchema },
  { filterableFields: ["load_id"] },
);

export const GET = routes.list;
export const POST = routes.create;
