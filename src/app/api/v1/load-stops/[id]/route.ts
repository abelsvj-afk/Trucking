import { createCrudRoutes } from "@/services/api/crud-routes";
import { createLoadStopSchema, updateLoadStopSchema } from "@/data/schemas/load-stops";
import type { LoadStop } from "@/types/entities";

const routes = createCrudRoutes<LoadStop>("load_stops", { create: createLoadStopSchema, update: updateLoadStopSchema });

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
