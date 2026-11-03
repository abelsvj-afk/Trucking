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

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
