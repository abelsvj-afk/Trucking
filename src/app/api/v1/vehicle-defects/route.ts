import { createCrudRoutes } from "@/services/api/crud-routes";
import {
  createVehicleDefectSchema,
  updateVehicleDefectSchema,
} from "@/data/schemas/vehicle-defects";
import type { VehicleDefect } from "@/types/entities";

// Vehicle defects (migration 00043, Image Intelligence §5.5):
// tracked observed problems. The truck page reads its open ones
// from here; Abel reads/writes through his own tools.
const routes = createCrudRoutes<VehicleDefect>(
  "vehicle_defects",
  { create: createVehicleDefectSchema, update: updateVehicleDefectSchema },
  { filterableFields: ["truck_id", "trailer_id", "status"] },
);

export const GET = routes.list;
export const POST = routes.create;
