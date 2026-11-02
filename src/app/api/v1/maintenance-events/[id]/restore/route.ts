import { createCrudRoutes } from "@/services/api/crud-routes";
import {
  createMaintenanceEventSchema,
  updateMaintenanceEventSchema,
} from "@/data/schemas/maintenance-events";
import type { MaintenanceEvent } from "@/types/entities";

const routes = createCrudRoutes<MaintenanceEvent>(
  "maintenance_events",
  { create: createMaintenanceEventSchema, update: updateMaintenanceEventSchema },
  { filterableFields: ["truck_id"] },
);

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
