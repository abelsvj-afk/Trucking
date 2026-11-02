import { createCrudRoutes } from "@/services/api/crud-routes";
import {
  createMaintenanceScheduleSchema,
  updateMaintenanceScheduleSchema,
} from "@/data/schemas/maintenance-schedules";
import type { MaintenanceSchedule } from "@/types/entities";

const routes = createCrudRoutes<MaintenanceSchedule>(
  "maintenance_schedules",
  { create: createMaintenanceScheduleSchema, update: updateMaintenanceScheduleSchema },
  { filterableFields: ["truck_id", "trailer_id"] },
);

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
