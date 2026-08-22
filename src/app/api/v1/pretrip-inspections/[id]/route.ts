import { createCrudRoutes } from "@/services/api/crud-routes";
import {
  createPretripInspectionSchema,
  updatePretripInspectionSchema,
} from "@/data/schemas/pretrip-inspections";
import type { PretripInspection } from "@/types/entities";

const routes = createCrudRoutes<PretripInspection>(
  "pretrip_inspections",
  { create: createPretripInspectionSchema, update: updatePretripInspectionSchema },
  { filterableFields: ["truck_id", "trailer_id"] },
);

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
