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

export const GET = routes.list;
export const POST = routes.create;
